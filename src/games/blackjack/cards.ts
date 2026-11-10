export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

/** A hand's best total; `soft` when an ace counts as 11 in it. */
export interface HandTotal {
  readonly total: number;
  readonly soft: boolean;
}

const VALUES: Readonly<Record<Rank, number>> = {
  A: 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 10,
  Q: 10,
  K: 10,
};

/** A card's value with an ace as 1; J, Q and K are 10, so K+Q is a pair for splitting. */
export function cardValue(card: Card): number {
  return VALUES[card.rank];
}

/** The best total: one ace counts as 11 when that doesn't bust the hand. */
export function handTotal(cards: readonly Card[]): HandTotal {
  let total = 0;
  let ace = false;
  for (const card of cards) {
    total += VALUES[card.rank];
    if (card.rank === 'A') ace = true;
  }
  return ace && total + 10 <= 21 ? { total: total + 10, soft: true } : { total, soft: false };
}

/** Two cards worth 21: an ace and a ten-value card. */
export function isNatural(cards: readonly Card[]): boolean {
  return cards.length === 2 && handTotal(cards).total === 21;
}

/** `decks` complete decks in a fixed order: deck by deck, suit by suit, ace to king. */
export function orderedDecks(decks: number): Card[] {
  const cards: Card[] = [];
  for (let deck = 0; deck < decks; deck += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push({ rank, suit });
    }
  }
  return cards;
}
