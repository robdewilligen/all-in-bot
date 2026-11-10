import { describe, expect, it, vi } from 'vitest';
import {
  BALANCE_TIMEOUT_MS,
  betChoices,
  respondWithBetChoices,
} from '../../src/bot/bet-autocomplete.js';
import { gameConfig } from '../../src/config/game.js';
import { t, translate, type Message } from '../../src/i18n/index.js';
import { captureLogs, fakeContext } from '../helpers/context.js';
import { fakeAutocomplete, GUILD_ID, USER_ID } from '../helpers/discord.js';

const limits = gameConfig.stakes;

function refused(...error: Message): string {
  const reason = translate('en-US', error).replaceAll('`', '');
  return t('en-US', 'amount.choiceError', { error: reason });
}

function choices(typed: string, balance: number | null): ReturnType<typeof betChoices> {
  return betChoices(typed, balance, limits, 'en-US');
}

async function suggest(typed: string, balance: number | Error) {
  const { logger, lines } = captureLogs();
  const context = fakeContext({ logger });
  if (balance instanceof Error) context.wallet.balanceOf.mockRejectedValue(balance);
  else context.wallet.balanceOf.mockResolvedValue(balance);
  const { interaction, calls } = fakeAutocomplete('spin', {
    focused: { name: 'bet', value: typed },
  });

  await expect(respondWithBetChoices(interaction, context)).resolves.toBeUndefined();

  return { calls, lines, context, interaction };
}

describe('respondWithBetChoices', () => {
  it('answers in time when the balance is slow, with only the typed amount', async () => {
    vi.useFakeTimers();
    try {
      const { logger, lines } = captureLogs();
      const context = fakeContext({ logger });
      context.wallet.balanceOf.mockReturnValue(new Promise<number>(() => undefined));
      const { interaction, calls } = fakeAutocomplete('spin', {
        focused: { name: 'bet', value: '2500' },
      });
      const answered = respondWithBetChoices(interaction, context);
      await vi.advanceTimersByTimeAsync(BALANCE_TIMEOUT_MS);
      await answered;
      expect(calls).toEqual([
        { method: 'respond', options: [{ name: '🪙 2,500', value: '2500' }] },
      ]);
      expect(lines.map((line) => line.msg)).toEqual([
        'reading the balance for autocomplete took too long',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows errors without markdown backticks, which a choice name would show literally', () => {
    expect(translate('en-US', ['amount.grouping'])).toContain('`');
    const [first] = choices('2.5', 5_000);
    expect(first?.name).toMatch(/^✗ Without k or m, , and \. separate thousands/);
    expect(first?.name).not.toContain('`');
  });

  it('suggests the typed amount first, then All-in and Half from the live balance', async () => {
    const { calls, context } = await suggest('2.5k', 5_000);

    expect(calls).toEqual([
      {
        method: 'respond',
        options: [
          { name: '🪙 2,500', value: '2.5k' },
          { name: 'All-in · 🪙 5,000', value: 'all' },
          { name: 'Half · 🪙 2,500', value: 'half' },
        ],
      },
    ]);
    expect(context.wallet.balanceOf.mock.calls).toEqual([[{ guildId: GUILD_ID, userId: USER_ID }]]);
  });

  it('suggests Max instead of All-in when the balance is above the maximum stake', async () => {
    const { calls } = await suggest('', 1_500_000);

    expect(calls).toEqual([
      {
        method: 'respond',
        options: [
          { name: 'Max · 🪙 1,000,000', value: 'max' },
          { name: 'Half · 🪙 750,000', value: 'half' },
        ],
      },
    ]);
  });

  it('shows what is wrong with the typed amount as the first choice, keeping the text', async () => {
    const { calls } = await suggest('2.5', 5_000);

    expect(calls).toEqual([
      {
        method: 'respond',
        options: [
          { name: refused('amount.grouping'), value: '2.5' },
          { name: 'All-in · 🪙 5,000', value: 'all' },
          { name: 'Half · 🪙 2,500', value: 'half' },
        ],
      },
    ]);
    expect(refused('amount.grouping')).toMatch(/^✗ \S/);
  });

  it('offers a typed number when the balance cannot be read, and logs why', async () => {
    const { calls, lines } = await suggest('2.5k', new Error('database down'));

    expect(calls).toEqual([{ method: 'respond', options: [{ name: '🪙 2,500', value: '2.5k' }] }]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'could not read the balance for autocomplete',
        guildId: GUILD_ID,
        userId: USER_ID,
        command: 'spin',
        err: expect.objectContaining({ message: 'database down' }) as unknown,
      }),
    ]);
  });

  it.each<[string, string[]]>([
    ['abc', [refused('amount.invalid')]],
    ['5', [refused('amount.belowMinimum', { stake: '🪙 5', min: '🪙 10' })]],
    ['half', []],
    ['', []],
  ])('without a balance offers only what does not need it, for %j', async (typed, names) => {
    const { calls } = await suggest(typed, new Error('database down'));

    expect(calls).toEqual([
      {
        method: 'respond',
        options: names.map((name) => ({ name, value: typed })),
      },
    ]);
  });

  it('survives a respond that fails, and logs it', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    context.wallet.balanceOf.mockResolvedValue(5_000);
    const { interaction } = fakeAutocomplete('spin', { focused: { name: 'bet', value: '1k' } });
    Object.assign(interaction, {
      respond: () => Promise.reject(new Error('Unknown interaction')),
    });

    await expect(respondWithBetChoices(interaction, context)).resolves.toBeUndefined();

    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      [40, 'could not answer autocomplete'],
    ]);
  });

  it('answers with no choices when building them fails, and logs it', async () => {
    const { logger, lines } = captureLogs();
    const context = fakeContext({ logger });
    context.wallet.balanceOf.mockResolvedValue(5_000);
    const { interaction, calls } = fakeAutocomplete('spin', {
      focused: { name: 'bet', value: '1k' },
    });
    Object.assign(interaction.options, {
      getFocused: () => {
        throw new Error('no focused option');
      },
    });

    await expect(respondWithBetChoices(interaction, context)).resolves.toBeUndefined();

    expect(calls).toEqual([{ method: 'respond', options: [] }]);
    expect(lines).toEqual([
      expect.objectContaining({ level: 50, msg: 'autocomplete failed', command: 'spin' }),
    ]);
  });
});

describe('betChoices', () => {
  it('keeps All-in at a balance of exactly the maximum stake', () => {
    expect(choices('', 1_000_000)).toEqual([
      { name: 'All-in · 🪙 1,000,000', value: 'all' },
      { name: 'Half · 🪙 500,000', value: 'half' },
    ]);
  });

  it.each<[number, string[]]>([
    [3_000_000, ['Max · 🪙 1,000,000']],
    [20, ['All-in · 🪙 20', 'Half · 🪙 10']],
    [19, ['All-in · 🪙 19']],
    [9, []],
    [1, []],
    [0, []],
  ])(
    'with a balance of %i, leaves out keyword choices outside the stake limits',
    (coins, names) => {
      expect(choices('', coins).map((choice) => choice.name)).toEqual(names);
    },
  );

  it('warns about a typed amount outside the stake limits', () => {
    expect(choices('5', 5_000)[0]).toEqual({
      name: refused('amount.belowMinimum', { stake: '🪙 5', min: '🪙 10' }),
      value: '5',
    });
    expect(choices('2m', 5_000)[0]).toEqual({
      name: refused('amount.aboveMaximum', { stake: '🪙 2,000,000', max: '🪙 1,000,000' }),
      value: '2m',
    });
  });

  it('shows a typed keyword with its amount, and does not repeat it', () => {
    expect(choices('HALF', 5_000)).toEqual([
      { name: 'Half · 🪙 2,500', value: 'HALF' },
      { name: 'All-in · 🪙 5,000', value: 'all' },
    ]);
    expect(choices('alles', 5_000)).toEqual([
      { name: 'All-in · 🪙 5,000', value: 'alles' },
      { name: 'Half · 🪙 2,500', value: 'half' },
    ]);
    expect(choices('max', 1_500_000)).toEqual([
      { name: 'Max · 🪙 1,000,000', value: 'max' },
      { name: 'Half · 🪙 750,000', value: 'half' },
    ]);
  });

  it('explains why a typed keyword does not work', () => {
    expect(choices('all', 1_500_000)).toEqual([
      {
        name: refused('amount.allAboveMax', { balance: '🪙 1,500,000', max: '🪙 1,000,000' }),
        value: 'all',
      },
      { name: 'Max · 🪙 1,000,000', value: 'max' },
      { name: 'Half · 🪙 750,000', value: 'half' },
    ]);
    expect(choices('half', 1)).toEqual([
      { name: refused('amount.halfIsZero', { balance: '🪙 1' }), value: 'half' },
    ]);
    expect(choices('all', 0)).toEqual([{ name: refused('amount.noCoins'), value: 'all' }]);
  });

  it('uses the typed text without surrounding whitespace as the value', () => {
    expect(choices('  2k  ', 5_000)[0]).toEqual({ name: '🪙 2,000', value: '2k' });
  });

  it('offers typed text of 100 characters, and nothing at all for longer text', () => {
    const hundred = '9'.repeat(100);

    expect(choices(hundred, 5_000)[0]).toEqual({
      name: refused('amount.tooLarge', { max: '🪙 1,000,000' }),
      value: hundred,
    });
    expect(choices(`${hundred}9`, 5_000)).toEqual([]);
  });

  it('keeps every name within 100 characters without cutting an emoji in half', () => {
    const names: string[] = [];
    for (let maxDigits = 1; maxDigits <= 15; maxDigits++) {
      const max = 10 ** maxDigits - 1;
      for (let balanceDigits = maxDigits + 1; balanceDigits <= 16; balanceDigits++) {
        const balance = Math.min(10 ** balanceDigits - 1, Number.MAX_SAFE_INTEGER);
        for (const typed of ['all', 'max', 'half', '']) {
          const offered = betChoices(typed, balance, { min: 1, max }, 'en-US');
          names.push(...offered.map((choice) => choice.name));
        }
      }
    }

    expect(names.filter((name) => name.endsWith('…')).length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(100);
      expect(name.isWellFormed()).toBe(true);
    }
  });
});
