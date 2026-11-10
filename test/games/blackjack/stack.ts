import {
  BlackjackRound,
  type BlackjackRules,
  type Card,
  type CardSource,
  type Draw,
  type PlayerAction,
  type Rank,
  type SeatResult,
  type SeatView,
  type Suit,
} from '../../../src/games/blackjack/index.js';

/** SPEC §7's rules, spelled out so a config change can't silently change what these tests prove. */
export const RULES: BlackjackRules = {
  decks: 6,
  cutCardPercent: 75,
  dealerHitsSoft17: false,
  blackjackPays: { numerator: 3, denominator: 2 },
  maxHands: 4,
  doubleAfterSplit: true,
  lateSurrender: true,
};

export const SEATS = ['ann', 'bob', 'cy', 'dee'] as const;

export function card(rank: Rank, suit: Suit = 'spades'): Card {
  return { rank, suit };
}

export const ranks = (cards: readonly Card[]): Rank[] => cards.map((dealt) => dealt.rank);

/** Deals exactly these cards in this order, and fails the test when a round wants more. */
export class StackedDeck implements CardSource {
  readonly #cards: Card[];

  constructor(cards: readonly (Rank | Card)[]) {
    this.#cards = cards.map((next) => (typeof next === 'string' ? card(next) : next));
  }

  get left(): number {
    return this.#cards.length;
  }

  deal(): Card {
    const next = this.#cards.shift();
    if (next === undefined) throw new Error('the stacked deck ran out');
    return next;
  }
}

export interface Layout {
  /** Every seat's two opening cards, in seat order: ann, bob, cy, dee. */
  readonly seats: readonly (readonly [Rank, Rank])[];
  /** Upcard, then hole card. */
  readonly dealer: readonly [Rank, Rank];
  /** The cards after the deal, in the order the round draws them. */
  readonly then?: readonly Rank[];
  /** Per seat; 10 by default. */
  readonly bets?: readonly number[];
  readonly rules?: Partial<BlackjackRules>;
}

/** Stacks the deck in SPEC §7 dealing order for this layout and deals a round from it. */
export function deal(layout: Layout): { round: BlackjackRound; deck: StackedDeck } {
  const { seats, dealer, then = [], bets = [] } = layout;
  const deck = new StackedDeck([
    ...seats.map(([first]) => first),
    dealer[0],
    ...seats.map(([, second]) => second),
    dealer[1],
    ...then,
  ]);
  const seatBets = seats.map((_, index) => ({
    id: SEATS[index] ?? `seat${index}`,
    bet: bets[index] ?? 10,
  }));
  return { round: new BlackjackRound({ ...RULES, ...layout.rules }, deck, seatBets), deck };
}

export function seatOf(round: BlackjackRound, seatId = 'ann'): SeatView {
  const seat = round.view().seats.find((candidate) => candidate.id === seatId);
  if (seat === undefined) throw new Error(`seat ${seatId} isn't in the round`);
  return seat;
}

export function resultOf(round: BlackjackRound, seatId = 'ann'): SeatResult {
  const seat = round.result().seats.find((candidate) => candidate.id === seatId);
  if (seat === undefined) throw new Error(`seat ${seatId} has no result`);
  return seat;
}

export const actionsOf = (round: BlackjackRound): PlayerAction[] =>
  round.actions().map((option) => option.action);

/** mulberry32: a small seeded generator, so shuffles in tests repeat. */
export function seededDraw(seed: number): Draw {
  let state = seed >>> 0;
  return (max) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}
