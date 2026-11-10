import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gameConfig } from '../../../src/config/game.js';
import { Shoe, type Card, type Draw } from '../../../src/games/blackjack/index.js';
import { card, RULES, seededDraw } from './stack.js';

const ONE_DECK = { decks: 1, cutCardPercent: 75 };
/** Draws the top of every range, so Fisher–Yates swaps nothing and the shoe stays in order. */
const inOrder: Draw = (max) => max - 1;

function dealAll(shoe: Shoe, count: number): Card[] {
  return Array.from({ length: count }, () => shoe.deal());
}

describe('the shoe', () => {
  it('uses the rules from the config, which are SPEC §7 defaults', () => {
    expect(gameConfig.blackjack).toEqual(RULES);
    const shoe = new Shoe(gameConfig.blackjack, randomInt);
    expect(shoe.size).toBe(312);
    expect(shoe.cardsLeft).toBe(312);
  });

  it('holds six complete decks', () => {
    const shoe = new Shoe(RULES, seededDraw(7));
    const counts = new Map<string, number>();
    for (const { rank, suit } of dealAll(shoe, 312)) {
      const key = `${rank} ${suit}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    expect(new Set(counts.values())).toEqual(new Set([6]));
    expect(shoe.cardsLeft).toBe(0);
  });

  it('shuffles with Fisher–Yates: one draw per place, over the places not yet fixed', () => {
    const maxes: number[] = [];
    new Shoe(RULES, (max) => {
      maxes.push(max);
      return max - 1;
    });
    expect(maxes).toEqual(Array.from({ length: 311 }, (_, index) => 312 - index));
  });

  it('swaps the place being fixed with the drawn place', () => {
    const ordered = dealAll(new Shoe(ONE_DECK, inOrder), 52);
    expect(ordered.slice(0, 2)).toEqual([card('A', 'clubs'), card('2', 'clubs')]);
    expect(ordered.at(-1)).toEqual(card('K', 'spades'));

    let first = true;
    const swapFirstWithLast: Draw = (max) => {
      if (!first) return max - 1;
      first = false;
      return 0;
    };
    const swapped = dealAll(new Shoe(ONE_DECK, swapFirstWithLast), 52);
    expect(swapped[0]).toEqual(card('K', 'spades'));
    expect(swapped.at(-1)).toEqual(card('A', 'clubs'));
    expect(swapped.slice(1, -1)).toEqual(ordered.slice(1, -1));
  });

  it('counts the cards left', () => {
    const shoe = new Shoe(RULES, seededDraw(1));
    dealAll(shoe, 10);
    expect(shoe.cardsLeft).toBe(302);
  });

  it('asks for a reshuffle once the cut card at 75% has been dealt', () => {
    const shoe = new Shoe(RULES, seededDraw(2));
    dealAll(shoe, 233);
    expect(shoe.reshuffleDue).toBe(false);
    shoe.deal();
    expect(shoe.cardsLeft).toBe(78);
    expect(shoe.reshuffleDue).toBe(true);
    shoe.deal();
    expect(shoe.reshuffleDue).toBe(true);

    shoe.shuffle();
    expect(shoe.cardsLeft).toBe(312);
    expect(shoe.reshuffleDue).toBe(false);
  });

  it('deals on from a freshly shuffled shoe when it runs out during a round', () => {
    let draws = 0;
    const shoe = new Shoe(ONE_DECK, (max) => {
      draws += 1;
      return max - 1;
    });
    dealAll(shoe, 52);
    expect(shoe.cardsLeft).toBe(0);
    expect(draws).toBe(51);

    expect(shoe.deal()).toEqual(card('A', 'clubs'));
    expect(draws).toBe(102);
    expect(shoe.cardsLeft).toBe(51);
    expect(shoe.reshuffleDue).toBe(false);
  });

  it('refuses a draw outside 0 to max - 1', () => {
    expect(() => new Shoe(ONE_DECK, (max) => max)).toThrow(RangeError);
    expect(() => new Shoe(ONE_DECK, () => -1)).toThrow(RangeError);
    expect(() => new Shoe(ONE_DECK, () => 0.5)).toThrow(RangeError);
  });

  it('refuses rules without a whole deck or with the cut card outside the shoe', () => {
    expect(() => new Shoe({ decks: 0, cutCardPercent: 75 }, inOrder)).toThrow(RangeError);
    expect(() => new Shoe({ decks: 6, cutCardPercent: 0 }, inOrder)).toThrow(RangeError);
    expect(() => new Shoe({ decks: 6, cutCardPercent: 101 }, inOrder)).toThrow(RangeError);
  });
});
