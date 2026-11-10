import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { colorOf, RED_NUMBERS, spin, WHEEL_ORDER } from '../../../src/games/roulette/index.js';

const SPEC_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const SPEC_REDS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

describe('the wheel', () => {
  it('has the European order from the spec, with every number from 0 to 36 once', () => {
    expect(WHEEL_ORDER).toEqual(SPEC_WHEEL);
    expect(WHEEL_ORDER.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
  });

  it('has the 18 red numbers from the spec', () => {
    expect(RED_NUMBERS).toEqual(SPEC_REDS);
  });

  it('colours 0 green, the red numbers red and every other number black', () => {
    expect(colorOf(0)).toBe('green');
    for (let n = 1; n <= 36; n++) {
      expect(colorOf(n), String(n)).toBe(SPEC_REDS.includes(n) ? 'red' : 'black');
    }
  });

  it('alternates red and black all the way around from 0', () => {
    const colours = WHEEL_ORDER.slice(1).map(colorOf);
    expect(colours).toHaveLength(36);
    colours.forEach((colour, i) => {
      expect(colour, `pocket ${i + 1}`).toBe(i % 2 === 0 ? 'red' : 'black');
    });
  });

  it('refuses a number that is not on the wheel', () => {
    for (const n of [-1, 37, 1.5, Number.NaN]) expect(() => colorOf(n)).toThrow(RangeError);
  });
});

describe('a spin', () => {
  it('draws one of 37 pockets and lands on what the draw returns', () => {
    const asked: number[] = [];
    const result = spin((max) => {
      asked.push(max);
      return 17;
    });
    expect(result).toBe(17);
    expect(asked).toEqual([37]);
    expect(spin((max) => max - 1)).toBe(36);
    expect(spin(() => 0)).toBe(0);
  });

  it('throws when the draw returns something off the wheel', () => {
    expect(() => spin((max) => max)).toThrow(RangeError);
    expect(() => spin(() => -1)).toThrow(RangeError);
  });

  it('works with crypto.randomInt', () => {
    for (let i = 0; i < 200; i++) {
      const result = spin(randomInt);
      expect(Number.isInteger(result) && result >= 0 && result <= 36).toBe(true);
    }
  });
});
