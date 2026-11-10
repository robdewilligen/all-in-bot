import type { RouletteColor } from './types.js';

/** The pockets in wheel order, clockwise from 0. */
export const WHEEL_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

/** The red numbers, ascending. */
export const RED_NUMBERS: readonly number[] = [
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
];

const POCKETS = WHEEL_ORDER.length;
const reds: ReadonlySet<number> = new Set(RED_NUMBERS);

/** Whether `n` is a number on the wheel: a whole number from 0 to 36. */
export function isPocket(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n < POCKETS;
}

function assertPocket(n: number): void {
  if (!isPocket(n)) throw new RangeError(`${n} is not a roulette number`);
}

/** The colour of a number: 0 is green. */
export function colorOf(n: number): RouletteColor {
  assertPocket(n);
  if (n === 0) return 'green';
  return reds.has(n) ? 'red' : 'black';
}

/** One spin. `draw(max)` returns a whole number from 0 to max - 1; the table passes crypto.randomInt. */
export function spin(draw: (max: number) => number): number {
  const result = draw(POCKETS);
  assertPocket(result);
  return result;
}

/** The numbers within `distance` pockets of `n` on the wheel, in wheel order. */
export function neighboursOf(n: number, distance: number): number[] {
  assertPocket(n);
  const index = WHEEL_ORDER.indexOf(n);
  const numbers: number[] = [];
  for (let offset = -distance; offset <= distance; offset++) {
    const pocket = WHEEL_ORDER[(index + offset + POCKETS) % POCKETS];
    if (pocket !== undefined) numbers.push(pocket);
  }
  return numbers;
}
