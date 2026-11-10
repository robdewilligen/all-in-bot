import type { Card } from './cards.js';
import type { ShoeRules } from './shoe.js';

/** The blackjack rules as one config object (SPEC §7); the table passes gameConfig.blackjack. */
export interface BlackjackRules extends ShoeRules {
  /** False: the dealer stands on every 17 (S17). True: the dealer hits soft 17 (H17). */
  readonly dealerHitsSoft17: boolean;
  /** A natural pays numerator:denominator, rounded down. */
  readonly blackjackPays: { readonly numerator: number; readonly denominator: number };
  /** Splitting stops at this many hands per seat. */
  readonly maxHands: number;
  readonly doubleAfterSplit: boolean;
  /** Surrender on the first two cards of an unsplit hand, after the dealer peeked. */
  readonly lateSurrender: boolean;
}

/** A seat that bet this round. `id` is the table's own, e.g. the player's user ID. */
export interface SeatBet {
  readonly id: string;
  readonly bet: number;
}

/** insurance: every seat answers at once. turns: one hand at a time. settled: all results are final. */
export type RoundPhase = 'insurance' | 'turns' | 'settled';

export type PlayerAction = 'hit' | 'stand' | 'double' | 'split' | 'surrender';

/**
 * An action the active hand may take and the extra stake it needs: the hand's bet for double and
 * split, 0 otherwise. The table raises the round in the wallet by `cost` before calling `act`.
 */
export interface ActionOption {
  readonly action: PlayerAction;
  readonly cost: number;
}

/** Whose turn it is: `hand` indexes that seat's hands. */
export interface Turn {
  readonly seatId: string;
  readonly hand: number;
}

export type InsuranceKind = 'insurance' | 'evenMoney';

export type InsuranceAnswer = 'pending' | 'taken' | 'declined';

/**
 * The question a seat answers while the dealer shows an ace: insurance costs half the bet, rounded
 * down; even money (for a seat with blackjack) costs nothing.
 */
export interface InsuranceOffer {
  readonly kind: InsuranceKind;
  readonly cost: number;
}

export type HandOutcome = 'blackjack' | 'evenMoney' | 'win' | 'push' | 'lose' | 'surrender';

export interface HandResult {
  readonly outcome: HandOutcome;
  /** The hand's stake, a double included. */
  readonly bet: number;
  /** What the hand returns, stake included: 0 for a loss. */
  readonly payout: number;
}

export interface HandView {
  readonly cards: readonly Card[];
  readonly total: number;
  readonly soft: boolean;
  /** A natural; 21 after a split isn't one. */
  readonly blackjack: boolean;
  readonly bust: boolean;
  readonly bet: number;
  readonly doubled: boolean;
  /**
   * Null until final: a bust or surrender is final at once, a natural (or even money) after the
   * peek, and any other hand after a dealer natural or the dealer's play.
   */
  readonly result: HandResult | null;
}

export interface InsuranceView extends InsuranceOffer {
  readonly answer: InsuranceAnswer;
  /**
   * Taken insurance returns 3 × cost on a dealer natural, else 0. Null before the peek, and for
   * declined insurance or even money (whose payout is its hand's result).
   */
  readonly payout: number | null;
}

export interface SeatView {
  readonly id: string;
  readonly hands: readonly HandView[];
  /** Null unless the dealer shows an ace. */
  readonly insurance: InsuranceView | null;
  /** The seat's turn timed out and the bot stood on its remaining hands. */
  readonly timedOut: boolean;
  /** Bets, doubles, splits and taken insurance so far. */
  readonly staked: number;
}

export interface DealerView {
  /** Only the upcard while the hole card is hidden, which lasts until the round is settled. */
  readonly cards: readonly Card[];
  readonly holeCardHidden: boolean;
  readonly total: number;
  readonly soft: boolean;
  readonly blackjack: boolean;
  readonly bust: boolean;
}

/** Everything a table message shows, as data. */
export interface RoundView {
  readonly phase: RoundPhase;
  readonly dealer: DealerView;
  readonly seats: readonly SeatView[];
  readonly turn: Turn | null;
}

export interface InsuranceResult {
  readonly cost: number;
  readonly payout: number;
}

export interface SeatResult {
  readonly id: string;
  readonly hands: readonly HandResult[];
  /** Insurance the seat took; even money shows as its hand's outcome instead. */
  readonly insurance: InsuranceResult | null;
  /** The bet plus every raise (doubles, splits, insurance): the stake of the wallet round. */
  readonly staked: number;
  /** Everything the seat gets back, stakes included: what the wallet settles. */
  readonly payout: number;
}

export interface RoundResult {
  readonly dealer: DealerView;
  readonly seats: readonly SeatResult[];
}
