import { describe, expect, it } from 'vitest';
import {
  cardValue,
  handTotal,
  isNatural,
  type HandTotal,
  type Rank,
} from '../../../src/games/blackjack/index.js';
import { card } from './stack.js';

const totalOf = (...cardRanks: Rank[]): HandTotal => handTotal(cardRanks.map((rank) => card(rank)));

describe('cards', () => {
  it('counts J, Q and K as 10 and an ace as 1', () => {
    expect((['J', 'Q', 'K', '10'] as const).map((rank) => cardValue(card(rank)))).toEqual([
      10, 10, 10, 10,
    ]);
    expect(cardValue(card('A'))).toBe(1);
    expect(cardValue(card('7'))).toBe(7);
  });

  it('counts one ace as 11 when that does not bust the hand, which makes it soft', () => {
    expect(totalOf('A', '6')).toEqual({ total: 17, soft: true });
    expect(totalOf('A', '6', '10')).toEqual({ total: 17, soft: false });
    expect(totalOf('A', 'A')).toEqual({ total: 12, soft: true });
    expect(totalOf('A', 'A', '9')).toEqual({ total: 21, soft: true });
    expect(totalOf('K', 'Q')).toEqual({ total: 20, soft: false });
    expect(totalOf('10', '6', '8')).toEqual({ total: 24, soft: false });
  });

  it('knows a natural: an ace and a ten-value card, and nothing else', () => {
    expect(isNatural([card('A'), card('K')])).toBe(true);
    expect(isNatural([card('10'), card('A')])).toBe(true);
    expect(isNatural([card('A'), card('5'), card('5')])).toBe(false);
    expect(isNatural([card('K'), card('Q')])).toBe(false);
  });
});
