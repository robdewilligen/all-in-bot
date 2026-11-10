import { cardValue, handTotal, isNatural, type Card } from './cards.js';
import type { CardSource } from './shoe.js';
import type {
  ActionOption,
  BlackjackRules,
  DealerView,
  HandResult,
  HandView,
  InsuranceAnswer,
  InsuranceKind,
  InsuranceOffer,
  PlayerAction,
  RoundPhase,
  RoundResult,
  RoundView,
  SeatBet,
  SeatResult,
  SeatView,
  Turn,
} from './types.js';

interface Hand {
  cards: Card[];
  bet: number;
  split: boolean;
  splitAces: boolean;
  doubled: boolean;
  /** Finished, waiting for the dealer's hand. */
  stood: boolean;
  result: HandResult | null;
}

interface Insurance {
  readonly kind: InsuranceKind;
  readonly cost: number;
  answer: InsuranceAnswer;
  payout: number | null;
}

interface Seat {
  readonly id: string;
  readonly hands: Hand[];
  insurance: Insurance | null;
  timedOut: boolean;
}

interface Active {
  readonly seat: Seat;
  readonly index: number;
  readonly hand: Hand;
}

function newHand(bet: number, cards: Card[] = []): Hand {
  return { cards, bet, split: false, splitAces: false, doubled: false, stood: false, result: null };
}

function isBlackjack(hand: Hand): boolean {
  return !hand.split && isNatural(hand.cards);
}

function isPlaying(hand: Hand): boolean {
  return hand.result === null && !hand.stood;
}

function isPair(cards: readonly Card[]): boolean {
  const [first, second] = cards;
  return (
    cards.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    cardValue(first) === cardValue(second)
  );
}

function lost(hand: Hand): HandResult {
  return { outcome: 'lose', bet: hand.bet, payout: 0 };
}

function pushed(hand: Hand): HandResult {
  return { outcome: 'push', bet: hand.bet, payout: hand.bet };
}

function compared(hand: Hand, dealer: number): HandResult {
  const player = handTotal(hand.cards).total;
  if (dealer > 21 || player > dealer)
    return { outcome: 'win', bet: hand.bet, payout: hand.bet * 2 };
  return player === dealer ? pushed(hand) : lost(hand);
}

function offerFor(seat: Seat): Insurance | null {
  const [hand] = seat.hands;
  if (hand === undefined) return null;
  if (isBlackjack(hand)) return { kind: 'evenMoney', cost: 0, answer: 'pending', payout: null };
  const cost = Math.floor(hand.bet / 2);
  return cost > 0 ? { kind: 'insurance', cost, answer: 'pending', payout: null } : null;
}

function takenInsurance(seat: Seat): Insurance | null {
  const { insurance } = seat;
  return insurance?.kind === 'insurance' && insurance.answer === 'taken' ? insurance : null;
}

function stakedBy(seat: Seat): number {
  const insurance = takenInsurance(seat)?.cost ?? 0;
  return seat.hands.reduce((sum, hand) => sum + hand.bet, insurance);
}

function splitHand(seat: Seat, index: number, hand: Hand): void {
  const [first, second] = hand.cards;
  if (first === undefined || second === undefined) throw new Error('only two cards can be split');
  const aces = first.rank === 'A';
  hand.cards = [first];
  hand.split = true;
  hand.splitAces = aces;
  seat.hands.splice(index + 1, 0, { ...newHand(hand.bet, [second]), split: true, splitAces: aces });
}

function handView(hand: Hand): HandView {
  const { total, soft } = handTotal(hand.cards);
  return {
    cards: [...hand.cards],
    total,
    soft,
    blackjack: isBlackjack(hand),
    bust: total > 21,
    bet: hand.bet,
    doubled: hand.doubled,
    result: hand.result,
  };
}

function seatView(seat: Seat): SeatView {
  return {
    id: seat.id,
    hands: seat.hands.map(handView),
    insurance: seat.insurance === null ? null : { ...seat.insurance },
    timedOut: seat.timedOut,
    staked: stakedBy(seat),
  };
}

function seatResult(seat: Seat): SeatResult {
  const hands = seat.hands.map((hand) => {
    if (hand.result === null) throw new Error(`seat ${seat.id} has a hand without a result`);
    return hand.result;
  });
  const taken = takenInsurance(seat);
  const insurance = taken === null ? null : { cost: taken.cost, payout: taken.payout ?? 0 };
  const payout = hands.reduce((sum, hand) => sum + hand.payout, insurance?.payout ?? 0);
  return { id: seat.id, hands, insurance, staked: stakedBy(seat), payout };
}

/**
 * One round at a blackjack table: every seat against one dealer hand (SPEC §7). The constructor
 * deals; then the table collects insurance answers (only under an ace), plays the turns until
 * `phase` is 'settled', and settles `result()` in the wallet. Every method throws on misuse (wrong
 * phase, seat or action), so the table checks `turn`, `actions()` and `insuranceOffer()` first.
 */
export class BlackjackRound {
  readonly #rules: BlackjackRules;
  readonly #source: CardSource;
  readonly #seats: Seat[];
  readonly #upcard: Card;
  readonly #hole: Card;
  readonly #draws: Card[] = [];
  #phase: RoundPhase = 'turns';

  /**
   * Deals in seat order: a card to every seat, the dealer's upcard, a second card to every seat,
   * then the hole card. The round can be settled at once: a dealer natural under a ten, or only
   * naturals at the table.
   */
  constructor(rules: BlackjackRules, source: CardSource, seats: readonly SeatBet[]) {
    if (seats.length === 0) throw new RangeError('a round needs at least one seat');
    if (new Set(seats.map((seat) => seat.id)).size !== seats.length) {
      throw new RangeError('every seat in a round needs its own id');
    }
    for (const { id, bet } of seats) {
      if (!Number.isSafeInteger(bet) || bet <= 0) {
        throw new RangeError(`seat ${id} bets ${bet}; a bet is a positive whole number`);
      }
    }
    this.#rules = rules;
    this.#source = source;
    this.#seats = seats.map(({ id, bet }) => ({
      id,
      hands: [newHand(bet)],
      insurance: null,
      timedOut: false,
    }));

    const opening = this.#seats.flatMap((seat) => seat.hands);
    for (const hand of opening) hand.cards.push(source.deal());
    this.#upcard = source.deal();
    for (const hand of opening) hand.cards.push(source.deal());
    this.#hole = source.deal();

    if (this.#upcard.rank === 'A') {
      for (const seat of this.#seats) seat.insurance = offerFor(seat);
      if (this.#seats.some((seat) => seat.insurance !== null)) {
        this.#phase = 'insurance';
        return;
      }
    }
    this.#peek();
  }

  get phase(): RoundPhase {
    return this.#phase;
  }

  /** The hand whose turn it is; null outside the turns phase. */
  get turn(): Turn | null {
    const active = this.#active();
    return active === undefined ? null : { seatId: active.seat.id, hand: active.index };
  }

  /** The seat's open insurance question; null once it answered or outside the insurance phase. */
  insuranceOffer(seatId: string): InsuranceOffer | null {
    if (this.#phase !== 'insurance') return null;
    const { insurance } = this.#seat(seatId);
    return insurance?.answer === 'pending' ? { kind: insurance.kind, cost: insurance.cost } : null;
  }

  /**
   * Records one seat's answer; an answer is final. Taking insurance needs its cost raised in the
   * wallet first. The last answer closes the insurance phase.
   */
  answerInsurance(seatId: string, take: boolean): void {
    if (this.#phase !== 'insurance') throw new Error('insurance is not open');
    const { insurance } = this.#seat(seatId);
    if (insurance?.answer !== 'pending') {
      throw new Error(`seat ${seatId} has no open insurance question`);
    }
    insurance.answer = take ? 'taken' : 'declined';
    if (this.#seats.every((seat) => seat.insurance?.answer !== 'pending')) this.#peek();
  }

  /** Ends the insurance phase when its time is up: no answer means no. Then the dealer peeks. */
  closeInsurance(): void {
    if (this.#phase !== 'insurance') throw new Error('insurance is not open');
    for (const seat of this.#seats) {
      if (seat.insurance?.answer === 'pending') seat.insurance.answer = 'declined';
    }
    this.#peek();
  }

  /** What the active hand may do, in button order; empty outside the turns phase. */
  actions(): ActionOption[] {
    const active = this.#active();
    if (active === undefined) return [];
    const { seat, hand } = active;
    const options: ActionOption[] = [
      { action: 'hit', cost: 0 },
      { action: 'stand', cost: 0 },
    ];
    if (hand.cards.length !== 2) return options;
    if (!hand.split || this.#rules.doubleAfterSplit) {
      options.push({ action: 'double', cost: hand.bet });
    }
    if (isPair(hand.cards) && seat.hands.length < this.#rules.maxHands) {
      options.push({ action: 'split', cost: hand.bet });
    }
    if (!hand.split && this.#rules.lateSurrender) options.push({ action: 'surrender', cost: 0 });
    return options;
  }

  /** Plays one action on the active hand, which must be this seat's and allow it. */
  act(seatId: string, action: PlayerAction): void {
    const { seat, index, hand } = this.#activeFor(seatId);
    if (!this.actions().some((option) => option.action === action)) {
      throw new Error(`${action} is not allowed on this hand`);
    }
    switch (action) {
      case 'hit':
        hand.cards.push(this.#source.deal());
        break;
      case 'stand':
        hand.stood = true;
        break;
      case 'double':
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(this.#source.deal());
        break;
      case 'split':
        splitHand(seat, index, hand);
        break;
      case 'surrender':
        hand.result = { outcome: 'surrender', bet: hand.bet, payout: Math.floor(hand.bet / 2) };
        break;
    }
    this.#advance();
  }

  /** The turn timed out: stands on every hand the seat has left, then the next seat plays. */
  standRemaining(seatId: string): void {
    const { seat } = this.#activeFor(seatId);
    seat.timedOut = true;
    for (let active = this.#active(); active?.seat === seat; active = this.#active()) {
      active.hand.stood = true;
      this.#advance();
    }
  }

  view(): RoundView {
    return {
      phase: this.#phase,
      dealer: this.#dealerView(),
      seats: this.#seats.map(seatView),
      turn: this.turn,
    };
  }

  /** Per seat what it staked and gets back; only once the round is settled. */
  result(): RoundResult {
    if (this.#phase !== 'settled') throw new Error('the round is not settled yet');
    return { dealer: this.#dealerView(), seats: this.#seats.map(seatResult) };
  }

  #seat(seatId: string): Seat {
    const seat = this.#seats.find((candidate) => candidate.id === seatId);
    if (seat === undefined) throw new Error(`seat ${seatId} isn't in this round`);
    return seat;
  }

  #active(): Active | undefined {
    if (this.#phase !== 'turns') return undefined;
    for (const seat of this.#seats) {
      const index = seat.hands.findIndex(isPlaying);
      const hand = seat.hands[index];
      if (hand !== undefined) return { seat, index, hand };
    }
    return undefined;
  }

  #activeFor(seatId: string): Active {
    const active = this.#active();
    if (active?.seat.id !== seatId) throw new Error(`it isn't seat ${seatId}'s turn`);
    return active;
  }

  #dealerCards(): Card[] {
    return [this.#upcard, this.#hole, ...this.#draws];
  }

  #dealerView(): DealerView {
    const hidden = this.#phase !== 'settled';
    const cards = hidden ? [this.#upcard] : this.#dealerCards();
    const { total, soft } = handTotal(cards);
    return {
      cards,
      holeCardHidden: hidden,
      total,
      soft,
      blackjack: !hidden && isNatural(cards),
      bust: total > 21,
    };
  }

  #peek(): void {
    // Only an ace or a ten-value upcard can make a natural, so checking for one is the peek.
    const dealerNatural = isNatural(this.#dealerCards());
    for (const seat of this.#seats) {
      const { insurance } = seat;
      const evenMoney = insurance?.kind === 'evenMoney' && insurance.answer === 'taken';
      const insured = takenInsurance(seat);
      if (insured !== null) insured.payout = dealerNatural ? insured.cost * 3 : 0;
      for (const hand of seat.hands) {
        if (evenMoney) hand.result = { outcome: 'evenMoney', bet: hand.bet, payout: hand.bet * 2 };
        else if (isBlackjack(hand)) hand.result = dealerNatural ? pushed(hand) : this.#paid(hand);
        else if (dealerNatural) hand.result = lost(hand);
      }
    }
    this.#phase = dealerNatural ? 'settled' : 'turns';
    this.#advance();
  }

  #paid(hand: Hand): HandResult {
    const { numerator, denominator } = this.#rules.blackjackPays;
    const winnings = Math.floor((hand.bet * numerator) / denominator);
    return { outcome: 'blackjack', bet: hand.bet, payout: hand.bet + winnings };
  }

  /** Readies the next hand to play, or plays the dealer when no hand is left. */
  #advance(): void {
    if (this.#phase !== 'turns') return;
    for (let active = this.#active(); active !== undefined; active = this.#active()) {
      const { hand } = active;
      // A split hand gets its second card when its turn comes.
      if (hand.cards.length === 1) hand.cards.push(this.#source.deal());
      const { total } = handTotal(hand.cards);
      if (total > 21) hand.result = lost(hand);
      else if (total === 21 || hand.doubled || hand.splitAces) hand.stood = true;
      else return;
    }
    this.#playDealer();
  }

  #playDealer(): void {
    const waiting = this.#seats
      .flatMap((seat) => seat.hands)
      .filter((hand) => hand.result === null);
    if (waiting.length > 0) {
      while (this.#dealerDraws()) this.#draws.push(this.#source.deal());
      const dealer = handTotal(this.#dealerCards()).total;
      for (const hand of waiting) hand.result = compared(hand, dealer);
    }
    this.#phase = 'settled';
  }

  #dealerDraws(): boolean {
    const { total, soft } = handTotal(this.#dealerCards());
    return total < 17 || (total === 17 && soft && this.#rules.dealerHitsSoft17);
  }
}
