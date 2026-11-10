import { describe, expect, it } from 'vitest';
import {
  amountKeyword,
  parseAmount,
  stakeLimitError,
  type AmountContext,
  type AmountKeyword,
  type ParsedAmount,
} from '../../src/core/amount.js';
import { en } from '../../src/i18n/en.js';
import { translate, type Message, type MessageKey } from '../../src/i18n/index.js';

const MAX = 1_000_000;
const limits = { min: 10, max: MAX };

function balance(coins: number): AmountContext {
  return { balance: coins, max: MAX };
}

const rich = balance(5_000);

function amount(value: number, keyword: AmountKeyword | null = null): ParsedAmount {
  return { ok: true, amount: value, keyword };
}

function refused(...error: Message): ParsedAmount {
  return { ok: false, error };
}

describe('parseAmount: numbers', () => {
  it.each<[string, number]>([
    ['250', 250],
    ['2,500', 2_500],
    ['2.500', 2_500],
    ['1.5k', 1_500],
    ['1,5k', 1_500],
    ['1.500k', 1_500],
    ['2k', 2_000],
    ['1m', 1_000_000],
  ])('reads the SPEC example %j as %i coins', (input, coins) => {
    expect(parseAmount(input, rich)).toEqual(amount(coins));
  });

  it.each<[string, number]>([
    ['1.000.000', 1_000_000],
    ['1,000,000', 1_000_000],
    ['12,345,678', 12_345_678],
    ['007', 7],
    ['0.5k', 500],
    ['2.25m', 2_250_000],
    ['1,234567m', 1_234_567],
    ['1.5000k', 1_500],
  ])('reads %j as %i coins', (input, coins) => {
    expect(parseAmount(input, rich)).toEqual(amount(coins));
  });

  it.each<[string, number]>([
    ['1.005k', 1_005],
    ['4.03m', 4_030_000],
    ['9007199254740.991k', 9_007_199_254_740_991],
  ])('works out %j exactly, where floating point would not (%i)', (input, coins) => {
    expect(parseAmount(input, rich)).toEqual(amount(coins));
  });

  it('ignores case and surrounding whitespace', () => {
    expect(parseAmount(' 1.5K ', rich)).toEqual(amount(1_500));
    expect(parseAmount('2M', rich)).toEqual(amount(2_000_000));
    expect(parseAmount('\t250\n', rich)).toEqual(amount(250));
  });

  it('accepts the largest safe integer', () => {
    expect(parseAmount('9007199254740991', rich)).toEqual(amount(Number.MAX_SAFE_INTEGER));
    expect(parseAmount('9,007,199,254,740,991', rich)).toEqual(amount(Number.MAX_SAFE_INTEGER));
  });

  it('reads a number the same whatever the balance; the wallet checks the funds', () => {
    expect(parseAmount('2,500', balance(0))).toEqual(amount(2_500));
  });
});

describe('parseAmount: refusals', () => {
  it.each<[string, MessageKey]>([
    ['2.5', 'amount.grouping'],
    ['2,50', 'amount.grouping'],
    ['25,00', 'amount.grouping'],
    ['1,0000', 'amount.grouping'],
    ['1.000.00', 'amount.grouping'],
    ['1,,000', 'amount.grouping'],
    [',500', 'amount.grouping'],
    ['500.', 'amount.grouping'],
    // Probably meant as half a coin; read as 500 it would bet a thousand times more.
    ['0,500', 'amount.grouping'],
    ['0.500', 'amount.grouping'],
    ['00.500', 'amount.grouping'],
    ['1.2345k', 'amount.fraction'],
    ['0.0005k', 'amount.fraction'],
    ['1.2345678m', 'amount.fraction'],
    ['1.000,5k', 'amount.mixed'],
    ['1,000.5', 'amount.mixed'],
    ['1.000.5k', 'amount.decimalPoint'],
    ['1,000,000k', 'amount.decimalPoint'],
    ['', 'amount.empty'],
    ['   ', 'amount.empty'],
    ['-250', 'amount.negative'],
    ['-1.5k', 'amount.negative'],
    ['abc', 'amount.invalid'],
    ['ten', 'amount.invalid'],
    ['1.5x', 'amount.invalid'],
    ['k', 'amount.invalid'],
    ['1kk', 'amount.invalid'],
    ['1k5', 'amount.invalid'],
    ['.5k', 'amount.invalid'],
    ['5.k', 'amount.invalid'],
    ['1e3', 'amount.invalid'],
    ['0x10', 'amount.invalid'],
    ['Infinity', 'amount.invalid'],
    ['NaN', 'amount.invalid'],
    ['+250', 'amount.invalid'],
    ['2 500', 'amount.invalid'],
    ['all in', 'amount.invalid'],
    ['halve', 'amount.invalid'],
    ['constructor', 'amount.invalid'],
    ['__proto__', 'amount.invalid'],
    ['0', 'amount.zero'],
    ['000', 'amount.zero'],
    ['0k', 'amount.zero'],
    ['0.000m', 'amount.zero'],
  ])('refuses %j with %s', (input, key) => {
    expect(parseAmount(input, rich)).toEqual({ ok: false, error: [key] });
  });

  it.each<[string, string]>([
    ['99999999999m', '99999999999m'],
    ['9007199254740992', '9007199254740992'],
    ['9,007,199,254,740,992', '9,007,199,254,740,992'],
    ['400 nines', '9'.repeat(400)],
    ['1 and 400 zeros, k', `1${'0'.repeat(400)}k`],
  ])('refuses the absurd amount %s instead of returning an unsafe number', (_label, input) => {
    expect(parseAmount(input, rich)).toEqual(refused('amount.tooLarge', { max: '🪙 1,000,000' }));
  });
});

describe('parseAmount: keywords', () => {
  it.each(['all', 'all-in', 'allin', 'alles', 'ALL', 'All-In', ' Alles ', 'ALLIN'])(
    '%j bets the whole balance',
    (input) => {
      expect(parseAmount(input, balance(5_000))).toEqual(amount(5_000, 'all'));
    },
  );

  it.each(['half', 'helft', 'HALF', ' Helft '])(
    '%j bets half the balance, rounded down',
    (input) => {
      expect(parseAmount(input, balance(1_235))).toEqual(amount(617, 'half'));
    },
  );

  it('max bets the balance, capped at the maximum stake', () => {
    expect(parseAmount('max', balance(5_000))).toEqual(amount(5_000, 'max'));
    expect(parseAmount('MAX', balance(3_000_000))).toEqual(amount(MAX, 'max'));
  });

  it('refuses all-in above the maximum stake and points to max', () => {
    const result = parseAmount('allin', balance(1_500_000));

    expect(result).toEqual(
      refused('amount.allAboveMax', { balance: '🪙 1,500,000', max: '🪙 1,000,000' }),
    );
    expect(result.ok ? '' : translate('en-US', result.error)).toMatch(/`max`/);
  });

  it('allows all-in at exactly the maximum stake', () => {
    expect(parseAmount('all', balance(MAX))).toEqual(amount(MAX, 'all'));
  });

  it('leaves half uncapped, so the stake limits refuse it', () => {
    expect(parseAmount('half', balance(3_000_000))).toEqual(amount(1_500_000, 'half'));
  });

  it.each(['all', 'max', 'half', 'alles', 'helft'])(
    '%j with a balance of 0 says there are no coins to bet',
    (input) => {
      expect(parseAmount(input, balance(0))).toEqual(refused('amount.noCoins'));
    },
  );

  it('half of a balance of 1 rounds down to 0, and says so', () => {
    const result = parseAmount('helft', balance(1));

    expect(result).toEqual(refused('amount.halfIsZero', { balance: '🪙 1' }));
    expect(result.ok ? '' : translate('en-US', result.error)).toMatch(/\b0 coins\b/);
    expect(parseAmount('all', balance(1))).toEqual(amount(1, 'all'));
    expect(parseAmount('max', balance(1))).toEqual(amount(1, 'max'));
  });

  it('never resolves max to 0 or less, even with a maximum of 0 or less', () => {
    expect(parseAmount('max', { balance: 500, max: 0 })).toEqual(refused('amount.zero'));
    expect(parseAmount('max', { balance: 500, max: -5 })).toEqual(refused('amount.zero'));
  });
});

describe('amountKeyword', () => {
  it('names the keyword behind every alias, and null for anything else', () => {
    expect(['all', 'All-In ', 'allin', 'alles'].map(amountKeyword)).toEqual([
      'all',
      'all',
      'all',
      'all',
    ]);
    expect(['max', 'half', 'HELFT'].map(amountKeyword)).toEqual(['max', 'half', 'half']);
    expect(['', '250', 'hal', 'constructor'].map(amountKeyword)).toEqual([null, null, null, null]);
  });
});

describe('stakeLimitError', () => {
  it('accepts stakes from the minimum up to the maximum', () => {
    expect([10, 500, MAX].map((stake) => stakeLimitError(stake, limits))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('refuses a stake below the minimum', () => {
    expect(stakeLimitError(9, limits)).toEqual([
      'amount.belowMinimum',
      { stake: '🪙 9', min: '🪙 10' },
    ]);
  });

  it('refuses a stake above the maximum', () => {
    expect(stakeLimitError(MAX + 1, limits)).toEqual([
      'amount.aboveMaximum',
      { stake: '🪙 1,000,001', max: '🪙 1,000,000' },
    ]);
  });
});

describe('messages', () => {
  it('has a reachable refusal for every amount message, each rendered in full', () => {
    const refusals: Message[] = [];
    const inputs: [string, AmountContext][] = [
      ['', rich],
      ['abc', rich],
      ['-5', rich],
      ['2.5', rich],
      ['1.000,5k', rich],
      ['1.000.5k', rich],
      ['1.2345k', rich],
      ['0', rich],
      ['99999999999m', rich],
      ['all', balance(0)],
      ['half', balance(1)],
      ['all', balance(1_500_000)],
    ];
    for (const [input, context] of inputs) {
      const result = parseAmount(input, context);
      if (!result.ok) refusals.push(result.error);
    }
    for (const stake of [9, MAX + 1]) {
      const error = stakeLimitError(stake, limits);
      if (error !== null) refusals.push(error);
    }

    const errorKeys = Object.keys(en.amount)
      .filter((key) => !key.startsWith('choice'))
      .map((key) => `amount.${key}`);
    expect(refusals.map(([key]) => key).sort()).toEqual(errorKeys.sort());
    for (const refusal of refusals) {
      expect(translate('en-US', refusal)).toMatch(/^[^{}]+\.$/);
    }
  });
});
