import { describe, expect, it } from 'vitest';
import { parseAmount, type AmountContext } from '../../../src/core/amount.js';
import { parseBets, settle, type RouletteBet } from '../../../src/games/roulette/index.js';
import { TABLE_BETS } from '../../../src/games/roulette/table.js';
import { translate, type Message } from '../../../src/i18n/index.js';

const CONTEXT: AmountContext = { balance: 10_000, max: 1_000_000 };
const ALL = Array.from({ length: 37 }, (_, i) => i);
const ONE_TO_36 = ALL.slice(1);
const REDS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const fromTo = (first: number, last: number): number[] => ALL.slice(first, last + 1);

function bets(input: string, context: AmountContext = CONTEXT): RouletteBet[] {
  const result = parseBets(input, context);
  if (!result.ok) throw new Error(`${input} was rejected: ${JSON.stringify(result.error)}`);
  return result.bets;
}

function only(input: string, context: AmountContext = CONTEXT): RouletteBet {
  const [bet, ...rest] = bets(input, context);
  if (bet === undefined || rest.length > 0) throw new Error(`${input} is not one bet`);
  return bet;
}

function rejection(input: string, context: AmountContext = CONTEXT): Message {
  const result = parseBets(input, context);
  if (result.ok) throw new Error(`${input} was accepted: ${JSON.stringify(result.bets)}`);
  return result.error;
}

function amountError(text: string): Message {
  const parsed = parseAmount(text, CONTEXT);
  if (parsed.ok) throw new Error(`${text} is a valid amount`);
  return parsed.error;
}

/** A table bet in short: label, kind, the numbers of its one chip and its amount. */
const short = (bet: RouletteBet): [string, string, readonly number[] | undefined, number] => [
  bet.label,
  bet.kind,
  bet.chips.length === 1 ? bet.chips[0]?.numbers : undefined,
  bet.amount,
];

describe('the notation from the spec', () => {
  it('places straights, splits, streets, trios, corners, the first four and six lines', () => {
    const cases: [string, string, string, number[]][] = [
      ['17', '17', 'straight', [17]],
      ['0', '0', 'straight', [0]],
      ['17/20', '17/20', 'split', [17, 20]],
      ['17-18', '17/18', 'split', [17, 18]],
      ['0/1', '0/1', 'split', [0, 1]],
      ['0/2', '0/2', 'split', [0, 2]],
      ['0/3', '0/3', 'split', [0, 3]],
      ['13-15', '13-15', 'street', [13, 14, 15]],
      ['0/1/2', '0/1/2', 'trio', [0, 1, 2]],
      ['0/2/3', '0/2/3', 'trio', [0, 2, 3]],
      ['1/2/4/5', '1/2/4/5', 'corner', [1, 2, 4, 5]],
      ['0-3', '0-3', 'firstFour', [0, 1, 2, 3]],
      ['1-6', '1-6', 'sixLine', [1, 2, 3, 4, 5, 6]],
    ];
    for (const [spot, label, kind, numbers] of cases) {
      expect(short(only(`10:${spot}`)), spot).toEqual([label, kind, numbers, 10]);
    }
  });

  it('places dozens, columns and even-money bets under every English, French and Dutch name', () => {
    const outside: Record<string, [string, number[], string[]]> = {
      d1: ['dozen', fromTo(1, 12), ['d1', '1st12', '1-12']],
      d2: ['dozen', fromTo(13, 24), ['d2', '2nd12', '13-24']],
      d3: ['dozen', fromTo(25, 36), ['d3', '3rd12', '25-36']],
      c1: ['column', ONE_TO_36.filter((n) => n % 3 === 1), ['c1', 'k1']],
      c2: ['column', ONE_TO_36.filter((n) => n % 3 === 2), ['c2', 'k2']],
      c3: ['column', ONE_TO_36.filter((n) => n % 3 === 0), ['c3', 'k3']],
      red: ['evenMoney', REDS, ['red', 'rouge', 'rood']],
      black: ['evenMoney', ONE_TO_36.filter((n) => !REDS.includes(n)), ['black', 'noir', 'zwart']],
      even: ['evenMoney', ONE_TO_36.filter((n) => n % 2 === 0), ['even', 'pair']],
      odd: ['evenMoney', ONE_TO_36.filter((n) => n % 2 === 1), ['odd', 'impair', 'oneven']],
      low: ['evenMoney', fromTo(1, 18), ['low', 'manque', 'laag', '1-18']],
      high: ['evenMoney', fromTo(19, 36), ['high', 'passe', 'hoog', '19-36']],
    };
    for (const [label, [kind, numbers, names]] of Object.entries(outside)) {
      for (const name of names) {
        expect(short(only(`10:${name}`)), name).toEqual([label, kind, numbers, 10]);
      }
    }
  });

  it('places the announced bets by name', () => {
    expect(bets('18:voisins 12:tiers 10:orphelins 8:jeu0 10:n17').map((bet) => bet.kind)).toEqual([
      'voisins',
      'tiers',
      'orphelins',
      'jeuZero',
      'neighbours',
    ]);
  });

  it('ignores upper case', () => {
    expect(short(only('10:RED'))).toEqual(short(only('10:red')));
    expect(short(only('10:Rouge'))).toEqual(short(only('10:red')));
    expect(short(only('10:1ST12'))).toEqual(short(only('10:d1')));
    expect(short(only('10:K2'))).toEqual(short(only('10:c2')));
    expect(only('18:Voisins').label).toBe('voisins');
    expect(only('8:JEU0').label).toBe('jeu0');
    expect(only('10:N17').label).toBe('n17');
  });

  it('places the same amount on several spots with +, as separate bets', () => {
    expect(bets('5:7+17+27').map(short)).toEqual([
      ['7', 'straight', [7], 5],
      ['17', 'straight', [17], 5],
      ['27', 'straight', [27], 5],
    ]);
    expect(bets('5:7+17+27').map((bet) => bet.countsAs)).toEqual([1, 1, 1]);
    expect(bets('18:red+voisins').map((bet) => [bet.label, bet.amount])).toEqual([
      ['red', 18],
      ['voisins', 18],
    ]);
  });
});

describe('resolving a spot by its numbers', () => {
  it('finds the same bet whatever the order of a set or a range', () => {
    const cases: [string, string][] = [
      ['20/17', '17/20'],
      ['18-17', '17/18'],
      ['15/13/14', '13-15'],
      ['13/14/15', '13-15'],
      ['2/1/0', '0/1/2'],
      ['0-2', '0/1/2'],
      ['5/4/2/1', '1/2/4/5'],
      ['3/2/1/0', '0-3'],
      ['6-1', '1-6'],
      ['17-17', '17'],
      ['12-1', 'd1'],
    ];
    for (const [spot, label] of cases) expect(only(`10:${spot}`).label, spot).toBe(label);
  });

  it('lets a player type every one of the 157 legal bets by its label and by its numbers', () => {
    for (const bet of TABLE_BETS) {
      const byLabel = only(`10:${bet.label}`);
      const byNumbers = only(`10:${bet.numbers.toReversed().join('/')}`);
      expect(short(byLabel), bet.label).toEqual([bet.label, bet.kind, bet.numbers, 10]);
      expect(short(byNumbers), bet.label).toEqual([bet.label, bet.kind, bet.numbers, 10]);
    }
  });

  it('accepts a range exactly when it is one bet on the table', () => {
    const rowOf = (n: number): number => Math.ceil(n / 3);
    const expected = ALL.map((n) => `${n}-${n}`);
    expected.push('0-1', '0-2', '0-3', '1-12', '13-24', '25-36', '1-18', '19-36');
    for (const n of ONE_TO_36) {
      if (n < 36 && rowOf(n) === rowOf(n + 1)) expected.push(`${n}-${n + 1}`);
      if (rowOf(n) !== rowOf(n - 1)) expected.push(`${n}-${n + 2}`);
      if (rowOf(n) !== rowOf(n - 1) && n <= 31) expected.push(`${n}-${n + 5}`);
    }

    const accepted: string[] = [];
    for (const from of ALL) {
      for (const to of ALL.slice(from)) {
        const result = parseBets(`10:${from}-${to}`, CONTEXT);
        if (!result.ok) continue;
        accepted.push(`${from}-${to}`);
        expect(result.bets[0]?.chips[0]?.numbers, `${from}-${to}`).toEqual(fromTo(from, to));
      }
    }
    expect(accepted).toHaveLength(92);
    expect(accepted.toSorted()).toEqual(expected.toSorted());
  });

  it('pays every bet a player can type 36 / n of its stake on each of its n numbers', () => {
    for (const bet of TABLE_BETS) {
      const placed = only(`${bet.numbers.length * 10}:${bet.label}`);
      for (const result of ALL) {
        const payout = settle([placed], result)[0]?.payout;
        expect(payout, `${bet.label} on ${result}`).toBe(bet.numbers.includes(result) ? 360 : 0);
      }
    }
  });
});

describe('separating bets', () => {
  it('reads the example from the spec as three bets of 10', () => {
    expect(bets('10:5, 10:15, 10:20').map(short)).toEqual([
      ['5', 'straight', [5], 10],
      ['15', 'straight', [15], 10],
      ['20', 'straight', [20], 10],
    ]);
  });

  it('splits on commas, semicolons and spaces, also several in a row', () => {
    const labels = (input: string): string[] => bets(input).map((bet) => bet.label);
    expect(labels('10:5,10:15;10:20 10:red')).toEqual(['5', '15', '20', 'red']);
    expect(labels(' 10:5 ,; 10:15\n10:20,, ')).toEqual(['5', '15', '20']);
  });

  it('keeps a comma inside an amount, because an amount runs up to its colon', () => {
    expect(bets('2,500:17, 10:red').map(short)).toEqual([
      ['17', 'straight', [17], 2_500],
      ['red', 'evenMoney', REDS, 10],
    ]);
    expect(bets('10:5,10:15').map(short)).toEqual([
      ['5', 'straight', [5], 10],
      ['15', 'straight', [15], 10],
    ]);
    expect(bets('2,500:17,2,500:18').map((bet) => [bet.label, bet.amount])).toEqual([
      ['17', 2_500],
      ['18', 2_500],
    ]);
    expect(only('1,5k:red').amount).toBe(1_500);
  });

  it('reads a spot followed by a comma and an amount as one amount, as the spec says', () => {
    expect(rejection('17,10:red')).toEqual(amountError('17,10'));
  });

  it('allows spaces around the colon and around +, / and -', () => {
    expect(short(only('10: 17'))).toEqual(['17', 'straight', [17], 10]);
    expect(short(only('10 :red'))).toEqual(['red', 'evenMoney', REDS, 10]);
    expect(short(only('10 : 17 / 20'))).toEqual(['17/20', 'split', [17, 20], 10]);
    expect(short(only('10:1 - 6'))).toEqual(['1-6', 'sixLine', fromTo(1, 6), 10]);
    expect(bets('5:7 + 17 +27').map((bet) => bet.label)).toEqual(['7', '17', '27']);
  });
});

describe('amounts', () => {
  it('reads every amount with the shared amount parser', () => {
    for (const amount of ['250', '2,500', '2.500', '1.5k', '1,5k', '2k', '1m', 'max', 'half']) {
      const parsed = parseAmount(amount, CONTEXT);
      expect(parsed.ok, amount).toBe(true);
      if (parsed.ok) expect(only(`${amount}:red`).amount, amount).toBe(parsed.amount);
    }
    expect(only('all:red').amount).toBe(10_000);
    expect(only('half:red').amount).toBe(5_000);
  });

  it('resolves keywords against the same balance for every bet in the command', () => {
    expect(bets('half:red, half:black').map((bet) => bet.amount)).toEqual([5_000, 5_000]);
  });

  it('passes on what is wrong with an amount', () => {
    for (const amount of ['2.5', '0', 'abc', '-5']) {
      expect(rejection(`${amount}:red`), amount).toEqual(amountError(amount));
    }
  });

  it('leaves the minimum stake to the round', () => {
    expect(only('1:red').amount).toBe(1);
  });
});

describe('rejecting what is not a bet', () => {
  it('rejects sets of numbers that are not one bet on the table, such as 1/3 and 1-4', () => {
    for (const spot of ['1/3', '1-4', '3/4', '1/2/3/4', '0/1/2/3/4', '0-36', '1-24', '1/5']) {
      expect(rejection(`10:${spot}`), spot).toEqual(['rouletteNotation.notOnTable', { spot }]);
    }
  });

  it('rejects numbers that are not on the wheel', () => {
    expect(rejection('10:37')).toEqual(['rouletteNotation.numberOutOfRange', { number: '37' }]);
    expect(rejection('10:0-37')).toEqual(['rouletteNotation.numberOutOfRange', { number: '37' }]);
    expect(rejection('10:36/37')).toEqual(['rouletteNotation.numberOutOfRange', { number: '37' }]);
    expect(rejection('10:n37')).toEqual(['rouletteNotation.numberOutOfRange', { number: '37' }]);
    expect(rejection('10:100')).toEqual(['rouletteNotation.numberOutOfRange', { number: '100' }]);
  });

  it('rejects spots it does not know, such as 00 from American roulette', () => {
    for (const spot of [
      '00',
      '07',
      'purple',
      'red/black',
      '1-2-3',
      'n',
      '17/',
      '/17',
      'd4',
      'c0',
    ]) {
      expect(rejection(`10:${spot}`), spot).toEqual(['rouletteNotation.unknownSpot', { spot }]);
    }
    expect(rejection('10:Purple')).toEqual(['rouletteNotation.unknownSpot', { spot: 'Purple' }]);
  });

  it('rejects a set that names a number twice', () => {
    expect(rejection('10:17/17')).toEqual([
      'rouletteNotation.repeatedNumber',
      { spot: '17/17', number: 17 },
    ]);
    expect(rejection('10:1/2/1')).toEqual([
      'rouletteNotation.repeatedNumber',
      { spot: '1/2/1', number: 1 },
    ]);
  });

  it('rejects a bet without its amount, colon or spot', () => {
    expect(rejection('17')).toEqual(['rouletteNotation.notABet', { text: '17' }]);
    expect(rejection('10:red 17')).toEqual(['rouletteNotation.notABet', { text: '17' }]);
    expect(rejection('10:red, 17, 10:black')).toEqual(['rouletteNotation.notABet', { text: '17' }]);
    expect(rejection(':17')).toEqual(['rouletteNotation.missingAmount', { bet: ':17' }]);
    expect(rejection('10:')).toEqual(['rouletteNotation.missingSpot', { bet: '10:' }]);
    expect(rejection('10:, 10:red')).toEqual(['rouletteNotation.missingSpot', { bet: '10:' }]);
    expect(rejection('5:7++17')).toEqual(['rouletteNotation.missingSpot', { bet: '5:7++17' }]);
    expect(rejection('5:7+')).toEqual(['rouletteNotation.missingSpot', { bet: '5:7+' }]);
  });

  it('rejects an empty command', () => {
    for (const input of ['', '   ', ' ,; ,']) {
      expect(rejection(input), JSON.stringify(input)).toEqual(['rouletteNotation.empty']);
    }
  });

  it('reports the first problem in the command', () => {
    expect(rejection('10:red, 10:purple, 10:37')).toEqual([
      'rouletteNotation.unknownSpot',
      { spot: 'purple' },
    ]);
  });

  it('explains every problem in English with its values filled in', () => {
    const inputs = ['', '17', ':17', '10:', '10:purple', '10:37', '10:17/17', '10:1/3'];
    inputs.push('10:voisins', 'all:voisins', Array.from({ length: 31 }, () => '1:red').join(' '));
    for (const input of inputs) {
      const text = translate('en', rejection(input, { balance: 5, max: 1_000_000 }));
      expect(text, input).not.toMatch(/[{}]/);
      expect(text.length, input).toBeGreaterThan(20);
    }
  });
});

describe('the bet limit', () => {
  const straights = (count: number): string =>
    Array.from({ length: count }, (_, i) => `1:${i % 37}`).join(', ');

  it('takes 30 bets in one command and rejects the 31st', () => {
    expect(bets(straights(30))).toHaveLength(30);
    expect(rejection(straights(31))).toEqual([
      'rouletteNotation.tooManyBets',
      { count: 31, max: 30 },
    ]);
  });

  it('counts every spot of a + bet', () => {
    const spots = (count: number): string => ALL.slice(0, count).join('+');
    expect(bets(`1:${spots(30)}`)).toHaveLength(30);
    expect(rejection(`1:${spots(31)}`)).toEqual([
      'rouletteNotation.tooManyBets',
      { count: 31, max: 30 },
    ]);
  });

  it('counts an announced bet as one', () => {
    const voisins = (count: number): string =>
      Array.from({ length: count }, () => '18:voisins').join(' ');
    expect(bets(voisins(30)).reduce((sum, bet) => sum + bet.countsAs, 0)).toBe(30);
    expect(rejection(voisins(31))).toEqual([
      'rouletteNotation.tooManyBets',
      { count: 31, max: 30 },
    ]);
  });

  it('takes another limit from the caller', () => {
    expect(parseBets('1:1, 1:2', CONTEXT, 2).ok).toBe(true);
    expect(parseBets('1:1, 1:2, 1:3', CONTEXT, 2)).toEqual({
      ok: false,
      error: ['rouletteNotation.tooManyBets', { count: 3, max: 2 }],
    });
  });
});
