import { randomInt } from 'node:crypto';
import { gameConfig } from '../src/config/game.js';
import {
  BlackjackRound,
  cardValue,
  handTotal,
  Shoe,
  type BlackjackRules,
  type Card,
  type PlayerAction,
} from '../src/games/blackjack/index.js';

const DEFAULT_HANDS = 1_000_000;
const BET = 100;
const SEAT = 'player';

/** Each chart letter as actions in order of preference: the first one the hand allows is played. */
const PLAYS: Readonly<Record<string, readonly PlayerAction[]>> = {
  H: ['hit'],
  S: ['stand'],
  D: ['double', 'hit'],
  d: ['double', 'stand'],
  R: ['surrender', 'hit'],
};

// Basic strategy for 4–8 decks, S17, double after split and late surrender. One column per dealer
// upcard: 2 to 10, then the ace. Totals outside a chart hit below it and stand above it.
const HARD: Readonly<Record<number, string>> = {
  9: 'HDDDDHHHHH',
  10: 'DDDDDDDDHH',
  11: 'DDDDDDDDDH',
  12: 'HHSSSHHHHH',
  13: 'SSSSSHHHHH',
  14: 'SSSSSHHHHH',
  15: 'SSSSSHHHRH',
  16: 'SSSSSHHRRR',
};
const SOFT: Readonly<Record<number, string>> = {
  13: 'HHHDDHHHHH',
  14: 'HHHDDHHHHH',
  15: 'HHDDDHHHHH',
  16: 'HHDDDHHHHH',
  17: 'HDDDDHHHHH',
  18: 'SddddSSHHH',
};
/** Per pair, by card value (an ace is 1): Y splits, N plays the total. */
const SPLITS: Readonly<Record<number, string>> = {
  1: 'YYYYYYYYYY',
  2: 'YYYYYYNNNN',
  3: 'YYYYYYNNNN',
  4: 'NNNYYNNNNN',
  5: 'NNNNNNNNNN',
  6: 'YYYYYNNNNN',
  7: 'YYYYYYNNNN',
  8: 'YYYYYYYYYY',
  9: 'YYYYYNYYNN',
  10: 'NNNNNNNNNN',
};

function basicStrategy(
  cards: readonly Card[],
  upcard: Card,
  allowed: ReadonlySet<PlayerAction>,
): PlayerAction {
  const upcardValue = cardValue(upcard);
  const column = upcardValue === 1 ? 9 : upcardValue - 2;
  const [first] = cards;
  if (
    allowed.has('split') &&
    first !== undefined &&
    SPLITS[cardValue(first)]?.charAt(column) === 'Y'
  ) {
    return 'split';
  }
  const { total, soft } = handTotal(cards);
  const lowest = soft ? 13 : 9;
  const letter = (soft ? SOFT : HARD)[total]?.charAt(column) ?? (total < lowest ? 'H' : 'S');
  const preferred = PLAYS[letter];
  if (preferred === undefined) throw new Error(`no play for chart letter ${letter}`);
  return preferred.find((action) => allowed.has(action)) ?? 'stand';
}

/** Plays one round and returns the player's net result in bets. */
function playRound(rules: BlackjackRules, shoe: Shoe): number {
  if (shoe.reshuffleDue) shoe.shuffle();
  const round = new BlackjackRound(rules, shoe, [{ id: SEAT, bet: BET }]);
  if (round.phase === 'insurance') round.closeInsurance();
  for (let turn = round.turn; turn !== null; turn = round.turn) {
    const view = round.view();
    const hand = view.seats[0]?.hands[turn.hand];
    const upcard = view.dealer.cards[0];
    if (hand === undefined || upcard === undefined) throw new Error('the view lacks the turn');
    const allowed = new Set(round.actions().map((option) => option.action));
    round.act(SEAT, basicStrategy(hand.cards, upcard, allowed));
  }
  const [seat] = round.result().seats;
  if (seat === undefined) throw new Error('the round has no result for the player');
  return (seat.payout - seat.staked) / BET;
}

function handsFromArgs(arg: string | undefined): number {
  if (arg === undefined) return DEFAULT_HANDS;
  const hands = Number(arg.replaceAll(/[_,]/g, ''));
  if (!Number.isSafeInteger(hands) || hands < 1) {
    console.error('Usage: npm run sim:blackjack -- [hands], a positive whole number');
    process.exit(1);
  }
  return hands;
}

const percent = (value: number): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(3)}%`;

const hands = handsFromArgs(process.argv[2]);
const rules: BlackjackRules = gameConfig.blackjack;
const shoe = new Shoe(rules, randomInt);
const started = performance.now();
let sum = 0;
let sumOfSquares = 0;
for (let played = 0; played < hands; played += 1) {
  const net = playRound(rules, shoe);
  sum += net;
  sumOfSquares += net * net;
}
const mean = sum / hands;
const deviation = Math.sqrt(sumOfSquares / hands - mean * mean);
const margin = (1.96 * deviation) / Math.sqrt(hands);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

console.log(
  `Blackjack: ${hands.toLocaleString('en-US')} hands at a one-seat table, basic strategy, no insurance`,
);
const ruleSummary = [
  `${rules.decks} decks`,
  `cut card at ${rules.cutCardPercent}%`,
  rules.dealerHitsSoft17 ? 'H17' : 'S17',
  `blackjack pays ${rules.blackjackPays.numerator}:${rules.blackjackPays.denominator}`,
  `split to ${rules.maxHands} hands`,
  ...(rules.doubleAfterSplit ? ['double after split'] : []),
  ...(rules.lateSurrender ? ['late surrender'] : []),
];
console.log(`Rules: ${ruleSummary.join(', ')}`);
console.log(
  `Expected return: ${percent(mean)} ± ${(margin * 100).toFixed(3)}% ` +
    `(95% interval ${percent(mean - margin)} to ${percent(mean + margin)})`,
);
console.log(`Standard deviation per hand: ${deviation.toFixed(3)} bets, in ${seconds} s`);
