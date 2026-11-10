import { orderedDecks, type Card } from './cards.js';

/** Returns a whole number from 0 to max - 1. The table passes crypto.randomInt. */
export type Draw = (max: number) => number;

/** Where a round takes its cards from: the table's shoe, or a stacked deck in tests. */
export interface CardSource {
  deal(): Card;
}

/** The part of the blackjack rules the shoe uses. */
export interface ShoeRules {
  readonly decks: number;
  /** The cut card's place, as a percentage of the shoe. */
  readonly cutCardPercent: number;
}

/**
 * A table's shoe (SPEC §7). It deals from a Fisher–Yates shuffle of every deck. Once the cut card
 * is out, `reshuffleDue` asks the table to call `shuffle()` before the next round; a shoe that runs
 * out during a round replaces itself with a freshly shuffled one and deals on.
 */
export class Shoe implements CardSource {
  readonly #decks: number;
  readonly #cutCard: number;
  readonly #draw: Draw;
  #cards: Card[] = [];
  #dealt = 0;

  constructor(rules: ShoeRules, draw: Draw) {
    if (!Number.isInteger(rules.decks) || rules.decks < 1) {
      throw new RangeError(`a shoe needs at least one whole deck, not ${rules.decks}`);
    }
    if (!(rules.cutCardPercent > 0 && rules.cutCardPercent <= 100)) {
      throw new RangeError(
        `the cut card must sit within the shoe, not at ${rules.cutCardPercent}%`,
      );
    }
    this.#decks = rules.decks;
    this.#cutCard = Math.floor((rules.decks * 52 * rules.cutCardPercent) / 100);
    this.#draw = draw;
    this.shuffle();
  }

  /** Cards in a full shoe. */
  get size(): number {
    return this.#cards.length;
  }

  get cardsLeft(): number {
    return this.#cards.length - this.#dealt;
  }

  /** The cut card has been dealt: shuffle before the next round. */
  get reshuffleDue(): boolean {
    return this.#dealt >= this.#cutCard;
  }

  /** Puts every card back and shuffles them. */
  shuffle(): void {
    const cards = orderedDecks(this.#decks);
    for (let i = cards.length - 1; i > 0; i -= 1) {
      const j = this.#draw(i + 1);
      const picked = Number.isInteger(j) && j >= 0 && j <= i ? cards[j] : undefined;
      const last = cards[i];
      if (picked === undefined || last === undefined) {
        throw new RangeError(`draw(${i + 1}) returned ${j}`);
      }
      cards[i] = picked;
      cards[j] = last;
    }
    this.#cards = cards;
    this.#dealt = 0;
  }

  deal(): Card {
    if (this.#dealt >= this.#cards.length) this.shuffle();
    const card = this.#cards[this.#dealt];
    if (card === undefined) throw new Error('the shoe is empty after a shuffle');
    this.#dealt += 1;
    return card;
  }
}
