import type { TableBetKind } from './types.js';
import { RED_NUMBERS } from './wheel.js';

/** One of the 157 bets on the layout of a European table. */
export interface TableBet {
  readonly kind: TableBetKind;
  /** Canonical notation: `17`, `0/1`, `13-15`, `0/1/2`, `1/2/4/5`, `0-3`, `1-6`, `d1`, `c1`, `red`. */
  readonly label: string;
  /** Ascending. */
  readonly numbers: readonly number[];
}

const fromTo = (first: number, last: number): number[] =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);

const ONE_TO_36 = fromTo(1, 36);

// Rows run 1-2-3 to 34-35-36: n + 1 is to the right unless n % 3 is 0, and n + 3 is below.
function buildTable(): TableBet[] {
  const bets: TableBet[] = [];
  const add = (kind: TableBetKind, label: string, numbers: readonly number[]): void => {
    bets.push({ kind, label, numbers: numbers.toSorted((a, b) => a - b) });
  };

  for (let n = 0; n <= 36; n++) add('straight', String(n), [n]);

  for (const n of [1, 2, 3]) add('split', `0/${n}`, [0, n]);
  for (const n of ONE_TO_36) {
    if (n % 3 !== 0) add('split', `${n}/${n + 1}`, [n, n + 1]);
    if (n <= 33) add('split', `${n}/${n + 3}`, [n, n + 3]);
  }

  for (let first = 1; first <= 34; first += 3) {
    add('street', `${first}-${first + 2}`, fromTo(first, first + 2));
  }
  add('trio', '0/1/2', [0, 1, 2]);
  add('trio', '0/2/3', [0, 2, 3]);

  for (const n of ONE_TO_36) {
    if (n <= 32 && n % 3 !== 0) {
      add('corner', `${n}/${n + 1}/${n + 3}/${n + 4}`, [n, n + 1, n + 3, n + 4]);
    }
  }
  add('firstFour', '0-3', [0, 1, 2, 3]);
  for (let first = 1; first <= 31; first += 3) {
    add('sixLine', `${first}-${first + 5}`, fromTo(first, first + 5));
  }

  for (const dozen of [1, 2, 3]) {
    add('dozen', `d${dozen}`, fromTo(dozen * 12 - 11, dozen * 12));
  }
  for (const column of [1, 2, 3]) {
    add(
      'column',
      `c${column}`,
      ONE_TO_36.filter((n) => n % 3 === column % 3),
    );
  }

  add('evenMoney', 'red', RED_NUMBERS);
  add(
    'evenMoney',
    'black',
    ONE_TO_36.filter((n) => !RED_NUMBERS.includes(n)),
  );
  add(
    'evenMoney',
    'even',
    ONE_TO_36.filter((n) => n % 2 === 0),
  );
  add(
    'evenMoney',
    'odd',
    ONE_TO_36.filter((n) => n % 2 === 1),
  );
  add('evenMoney', 'low', fromTo(1, 18));
  add('evenMoney', 'high', fromTo(19, 36));
  return bets;
}

/** Every legal bet of a European table: 157 in all. */
export const TABLE_BETS: readonly TableBet[] = buildTable();

const keyOf = (ascending: readonly number[]): string => ascending.join('/');
const byNumbers: ReadonlyMap<string, TableBet> = new Map(
  TABLE_BETS.map((bet) => [keyOf(bet.numbers), bet]),
);
const byLabel: ReadonlyMap<string, TableBet> = new Map(TABLE_BETS.map((bet) => [bet.label, bet]));

/** The table bet that covers exactly these numbers, in any order, if there is one. */
export function tableBetFor(numbers: readonly number[]): TableBet | undefined {
  return byNumbers.get(keyOf(numbers.toSorted((a, b) => a - b)));
}

/** The table bet with this canonical label, such as `red` or `d1`. */
export function tableBetByLabel(label: string): TableBet | undefined {
  return byLabel.get(label);
}
