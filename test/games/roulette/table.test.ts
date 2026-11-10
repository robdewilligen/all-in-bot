import { describe, expect, it } from 'vitest';
import { TABLE_BETS, tableBetFor, type TableBet } from '../../../src/games/roulette/table.js';
import type { TableBetKind } from '../../../src/games/roulette/types.js';

// An independent model of the layout: 1-36 in 12 rows of three, 0 above the first row.
const rowOf = (n: number): number => Math.ceil(n / 3);
const columnOf = (n: number): number => ((n - 1) % 3) + 1;
const ONE_TO_36 = Array.from({ length: 36 }, (_, i) => i + 1);
const ALL = [0, ...ONE_TO_36];
const REDS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((n) => b.includes(n));

function adjacent(a: number, b: number): boolean {
  if (a === 0 || b === 0) return a + b <= 3 && a !== b;
  const sameRow = rowOf(a) === rowOf(b) && Math.abs(columnOf(a) - columnOf(b)) === 1;
  const sameColumn = columnOf(a) === columnOf(b) && Math.abs(rowOf(a) - rowOf(b)) === 1;
  return sameRow || sameColumn;
}

const isRow = (numbers: readonly number[]): boolean =>
  numbers.length === 3 && numbers.every((n) => n > 0 && rowOf(n) === rowOf(numbers[0] ?? 0));

function isSquare(numbers: readonly number[]): boolean {
  if (numbers.length !== 4 || numbers.includes(0)) return false;
  const rows = new Set(numbers.map(rowOf));
  const columns = new Set(numbers.map(columnOf));
  const [top, bottom] = [...rows].toSorted((a, b) => a - b);
  const [left, right] = [...columns].toSorted((a, b) => a - b);
  return (
    rows.size === 2 &&
    columns.size === 2 &&
    top !== undefined &&
    bottom === top + 1 &&
    left !== undefined &&
    right === left + 1
  );
}

function combinations(size: number, from = 0): number[][] {
  if (size === 0) return [[]];
  const result: number[][] = [];
  for (let n = from; n <= 36; n++) {
    for (const rest of combinations(size - 1, n + 1)) result.push([n, ...rest]);
  }
  return result;
}

const ofKind = (kind: TableBetKind): TableBet[] => TABLE_BETS.filter((bet) => bet.kind === kind);

describe('the table of legal bets', () => {
  it('has the 157 bets of a European table, each with a different set of numbers', () => {
    expect(TABLE_BETS).toHaveLength(157);
    expect(new Set(TABLE_BETS.map((bet) => bet.numbers.join('/'))).size).toBe(157);
    expect(new Set(TABLE_BETS.map((bet) => bet.label)).size).toBe(157);
  });

  it('has the counts per type from the spec', () => {
    const kinds: TableBetKind[] = [
      'straight',
      'split',
      'street',
      'trio',
      'corner',
      'firstFour',
      'sixLine',
      'dozen',
      'column',
      'evenMoney',
    ];
    const counts = Object.fromEntries(kinds.map((kind) => [kind, ofKind(kind).length]));
    expect(counts).toEqual({
      straight: 37,
      split: 60,
      street: 12,
      trio: 2,
      corner: 22,
      firstFour: 1,
      sixLine: 11,
      dozen: 3,
      column: 3,
      evenMoney: 6,
    });
  });

  it("keeps every bet's numbers ascending and on the wheel", () => {
    for (const bet of TABLE_BETS) {
      expect(bet.numbers, bet.label).toEqual(bet.numbers.toSorted((a, b) => a - b));
      expect(
        bet.numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 36),
        bet.label,
      ).toBe(true);
    }
  });

  it('has a straight on every number, 0 included', () => {
    expect(ofKind('straight').map((bet) => bet.numbers)).toEqual(ALL.map((n) => [n]));
  });

  it('has a split on every pair of touching numbers, including 0/1, 0/2 and 0/3', () => {
    const pairs = combinations(2).filter(([a = -1, b = -1]) => adjacent(a, b));
    expect(pairs).toHaveLength(60);
    expect(ofKind('split').map((bet) => bet.numbers)).toEqual(expect.arrayContaining(pairs));
    expect(pairs).toEqual(
      expect.arrayContaining([
        [0, 1],
        [0, 2],
        [0, 3],
      ]),
    );
  });

  it('has a street on every row, the two trios and the first four', () => {
    for (const bet of ofKind('street')) expect(isRow(bet.numbers), bet.label).toBe(true);
    expect(ofKind('trio').map((bet) => bet.numbers)).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
    expect(ofKind('firstFour').map((bet) => bet.numbers)).toEqual([[0, 1, 2, 3]]);
  });

  it('has a corner on every square of four numbers', () => {
    const squares = combinations(4).filter(isSquare);
    expect(squares).toHaveLength(22);
    expect(ofKind('corner').map((bet) => bet.numbers)).toEqual(expect.arrayContaining(squares));
  });

  it('has a six line on every two neighbouring rows', () => {
    for (const bet of ofKind('sixLine')) {
      const [first = 0] = bet.numbers;
      expect(isRow(bet.numbers.slice(0, 3)) && isRow(bet.numbers.slice(3)), bet.label).toBe(true);
      expect(rowOf(bet.numbers[3] ?? 0), bet.label).toBe(rowOf(first) + 1);
    }
  });

  it('has the dozens, the columns and the even-money bets', () => {
    const outside = (kind: TableBetKind): Record<string, readonly number[]> =>
      Object.fromEntries(ofKind(kind).map((bet) => [bet.label, bet.numbers]));
    expect(outside('dozen')).toEqual({
      d1: ONE_TO_36.filter((n) => n <= 12),
      d2: ONE_TO_36.filter((n) => n > 12 && n <= 24),
      d3: ONE_TO_36.filter((n) => n > 24),
    });
    expect(outside('column')).toEqual({
      c1: ONE_TO_36.filter((n) => columnOf(n) === 1),
      c2: ONE_TO_36.filter((n) => columnOf(n) === 2),
      c3: ONE_TO_36.filter((n) => columnOf(n) === 3),
    });
    expect(outside('evenMoney')).toEqual({
      red: REDS,
      black: ONE_TO_36.filter((n) => !REDS.includes(n)),
      even: ONE_TO_36.filter((n) => n % 2 === 0),
      odd: ONE_TO_36.filter((n) => n % 2 === 1),
      low: ONE_TO_36.filter((n) => n <= 18),
      high: ONE_TO_36.filter((n) => n >= 19),
    });
  });
});

describe('looking a bet up by its numbers', () => {
  it('finds every legal bet from its numbers in any order', () => {
    for (const bet of TABLE_BETS) {
      expect(tableBetFor(bet.numbers.toReversed()), bet.label).toBe(bet);
    }
  });

  it('accepts exactly the touching pairs, the rows and trios, and the squares and first four', () => {
    const legal = (size: number): number[][] =>
      combinations(size).filter((numbers) => tableBetFor(numbers) !== undefined);
    expect(legal(2)).toEqual(combinations(2).filter(([a = -1, b = -1]) => adjacent(a, b)));
    expect(legal(3)).toEqual(
      combinations(3).filter(
        (numbers) => isRow(numbers) || sameSet(numbers, [0, 1, 2]) || sameSet(numbers, [0, 2, 3]),
      ),
    );
    expect(legal(4)).toEqual(
      combinations(4).filter((numbers) => isSquare(numbers) || sameSet(numbers, [0, 1, 2, 3])),
    );
  });

  it('rejects sets that are not one bet, such as 1/3 and 1-4', () => {
    expect(tableBetFor([1, 3])).toBeUndefined();
    expect(tableBetFor([1, 2, 3, 4])).toBeUndefined();
    expect(tableBetFor([3, 4])).toBeUndefined();
    expect(tableBetFor([])).toBeUndefined();
  });
});
