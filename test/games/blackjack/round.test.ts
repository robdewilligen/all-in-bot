import { describe, expect, it } from 'vitest';
import { actionsOf, card, deal, ranks, resultOf, seatOf } from './stack.js';

describe('the dealer', () => {
  it('stands on soft 17 under S17', () => {
    const { round, deck } = deal({ seats: [['10', '9']], dealer: ['6', 'A'], then: ['4'] });
    round.act('ann', 'stand');
    const { dealer } = round.result();
    expect(ranks(dealer.cards)).toEqual(['6', 'A']);
    expect(dealer).toMatchObject({ total: 17, soft: true });
    expect(resultOf(round).hands).toEqual([{ outcome: 'win', bet: 10, payout: 20 }]);
    expect(deck.left).toBe(1);
  });

  it('hits soft 17 under H17', () => {
    const { round, deck } = deal({
      seats: [['10', '9']],
      dealer: ['6', 'A'],
      then: ['4'],
      rules: { dealerHitsSoft17: true },
    });
    round.act('ann', 'stand');
    const { dealer } = round.result();
    expect(ranks(dealer.cards)).toEqual(['6', 'A', '4']);
    expect(dealer).toMatchObject({ total: 21, soft: true });
    expect(resultOf(round).hands).toEqual([{ outcome: 'lose', bet: 10, payout: 0 }]);
    expect(deck.left).toBe(0);
  });

  it.each([false, true])('draws to 16 and stands on hard 17 (H17: %s)', (dealerHitsSoft17) => {
    const { round, deck } = deal({
      seats: [['10', '9']],
      dealer: ['10', '6'],
      then: ['A', '5'],
      rules: { dealerHitsSoft17 },
    });
    round.act('ann', 'stand');
    expect(ranks(round.result().dealer.cards)).toEqual(['10', '6', 'A']);
    expect(round.result().dealer).toMatchObject({ total: 17, soft: false });
    expect(deck.left).toBe(1);
  });
});

describe('a natural', () => {
  it.each([
    [10, 25],
    [11, 27],
    [15, 37],
    [1_000_000, 2_500_000],
  ])('on a bet of %i pays %i: 3:2, rounded down', (bet, payout) => {
    const { round, deck } = deal({
      seats: [['A', 'K']],
      dealer: ['9', '7'],
      then: ['5'],
      bets: [bet],
    });
    expect(round.phase).toBe('settled');
    expect(resultOf(round)).toEqual({
      id: 'ann',
      hands: [{ outcome: 'blackjack', bet, payout }],
      insurance: null,
      staked: bet,
      payout,
    });
    expect(deck.left).toBe(1);
  });
});

describe('the peek', () => {
  it('ends the round at once when the dealer has a natural under a ten', () => {
    const { round, deck } = deal({ seats: [['10', '9']], dealer: ['K', 'A'], then: ['5'] });
    expect(round.phase).toBe('settled');
    expect(round.turn).toBeNull();
    expect(round.actions()).toEqual([]);
    expect(round.result().dealer).toMatchObject({ holeCardHidden: false, blackjack: true });
    expect(resultOf(round)).toEqual({
      id: 'ann',
      hands: [{ outcome: 'lose', bet: 10, payout: 0 }],
      insurance: null,
      staked: 10,
      payout: 0,
    });
    expect(deck.left).toBe(1);
  });

  it('pushes a natural against a dealer natural', () => {
    const { round } = deal({ seats: [['A', 'Q']], dealer: ['10', 'A'] });
    expect(resultOf(round).hands).toEqual([{ outcome: 'push', bet: 10, payout: 10 }]);
  });

  it('plays on with the hole card hidden when the dealer has no natural under a ten', () => {
    const { round } = deal({ seats: [['10', '9']], dealer: ['K', '7'] });
    expect(round.phase).toBe('turns');
    expect(round.view().dealer).toEqual({
      cards: [card('K')],
      holeCardHidden: true,
      total: 10,
      soft: false,
      blackjack: false,
      bust: false,
    });
  });

  it('comes after the insurance answers under an ace, and a natural ends the round', () => {
    const { round, deck } = deal({ seats: [['10', '9']], dealer: ['A', 'K'], then: ['5'] });
    expect(round.phase).toBe('insurance');
    expect(round.turn).toBeNull();
    expect(round.view().dealer).toMatchObject({ cards: [card('A')], holeCardHidden: true });
    round.answerInsurance('ann', false);
    expect(round.phase).toBe('settled');
    expect(resultOf(round)).toMatchObject({ hands: [{ outcome: 'lose', payout: 0 }], payout: 0 });
    expect(deck.left).toBe(1);
  });
});

describe('insurance', () => {
  it('costs half the bet and pays 2:1 when the dealer has blackjack', () => {
    const { round } = deal({ seats: [['10', '9']], dealer: ['A', 'K'] });
    expect(round.insuranceOffer('ann')).toEqual({ kind: 'insurance', cost: 5 });
    round.answerInsurance('ann', true);
    expect(round.phase).toBe('settled');
    expect(resultOf(round)).toEqual({
      id: 'ann',
      hands: [{ outcome: 'lose', bet: 10, payout: 0 }],
      insurance: { cost: 5, payout: 15 },
      staked: 15,
      payout: 15,
    });
  });

  it('costs half the bet rounded down', () => {
    const { round } = deal({ seats: [['10', '9']], dealer: ['A', 'K'], bets: [15] });
    expect(round.insuranceOffer('ann')).toEqual({ kind: 'insurance', cost: 7 });
    round.answerInsurance('ann', true);
    expect(resultOf(round)).toMatchObject({
      insurance: { cost: 7, payout: 21 },
      staked: 22,
      payout: 21,
    });
  });

  it('is lost when the dealer has no blackjack, and the hand plays on', () => {
    const { round } = deal({ seats: [['10', '9']], dealer: ['A', '7'] });
    round.answerInsurance('ann', true);
    expect(round.phase).toBe('turns');
    expect(seatOf(round).insurance).toEqual({
      kind: 'insurance',
      cost: 5,
      answer: 'taken',
      payout: 0,
    });
    round.act('ann', 'stand');
    expect(resultOf(round)).toEqual({
      id: 'ann',
      hands: [{ outcome: 'win', bet: 10, payout: 20 }],
      insurance: { cost: 5, payout: 0 },
      staked: 15,
      payout: 20,
    });
  });

  it('counts no answer as no insurance', () => {
    const { round } = deal({ seats: [['10', '9']], dealer: ['A', 'K'] });
    round.closeInsurance();
    expect(round.phase).toBe('settled');
    expect(seatOf(round).insurance).toMatchObject({ answer: 'declined', payout: null });
    expect(resultOf(round)).toMatchObject({ insurance: null, staked: 10, payout: 0 });
  });
});

describe('even money', () => {
  it.each(['K', '7'] as const)('pays a natural 1:1 whatever the hole card (%s)', (hole) => {
    const { round } = deal({ seats: [['A', 'K']], dealer: ['A', hole] });
    expect(round.insuranceOffer('ann')).toEqual({ kind: 'evenMoney', cost: 0 });
    round.answerInsurance('ann', true);
    expect(round.phase).toBe('settled');
    expect(resultOf(round)).toEqual({
      id: 'ann',
      hands: [{ outcome: 'evenMoney', bet: 10, payout: 20 }],
      insurance: null,
      staked: 10,
      payout: 20,
    });
  });

  it('declined, leaves a natural to push against blackjack or to win 3:2', () => {
    const pushes = deal({ seats: [['A', 'K']], dealer: ['A', 'Q'] }).round;
    pushes.answerInsurance('ann', false);
    expect(resultOf(pushes).hands).toEqual([{ outcome: 'push', bet: 10, payout: 10 }]);

    const wins = deal({ seats: [['A', 'K']], dealer: ['A', '6'] }).round;
    wins.answerInsurance('ann', false);
    expect(resultOf(wins).hands).toEqual([{ outcome: 'blackjack', bet: 10, payout: 25 }]);
  });
});

describe('the actions on a hand', () => {
  it('on a first pair: hit, stand, double and split for the bet, and surrender', () => {
    const { round } = deal({ seats: [['8', '8']], dealer: ['9', '7'], bets: [25] });
    expect(round.turn).toEqual({ seatId: 'ann', hand: 0 });
    expect(round.actions()).toEqual([
      { action: 'hit', cost: 0 },
      { action: 'stand', cost: 0 },
      { action: 'double', cost: 25 },
      { action: 'split', cost: 25 },
      { action: 'surrender', cost: 0 },
    ]);
  });

  it('split any two cards of equal value, K+Q too', () => {
    expect(actionsOf(deal({ seats: [['K', 'Q']], dealer: ['9', '7'] }).round)).toContain('split');
    expect(actionsOf(deal({ seats: [['K', '9']], dealer: ['9', '7'] }).round)).not.toContain(
      'split',
    );
  });

  it('come down to hit and stand after the first two cards', () => {
    const { round } = deal({ seats: [['2', '3']], dealer: ['9', '7'], then: ['4'] });
    round.act('ann', 'hit');
    expect(round.actions()).toEqual([
      { action: 'hit', cost: 0 },
      { action: 'stand', cost: 0 },
    ]);
  });

  it('end at 21: the hand stands by itself', () => {
    const { round, deck } = deal({ seats: [['5', '6']], dealer: ['9', '7'], then: ['K', '2'] });
    round.act('ann', 'hit');
    expect(round.turn).toBeNull();
    expect(round.phase).toBe('settled');
    expect(resultOf(round).hands).toEqual([{ outcome: 'win', bet: 10, payout: 20 }]);
    expect(deck.left).toBe(0);
  });

  it('are refused out of turn, out of phase or when not on offer', () => {
    const { round } = deal({ seats: [['10', '9']], dealer: ['9', '7'], then: ['2'] });
    expect(() => {
      round.act('bob', 'stand');
    }).toThrow(/turn/);
    expect(() => {
      round.act('ann', 'split');
    }).toThrow(/not allowed/);
    expect(() => {
      round.answerInsurance('ann', true);
    }).toThrow(/insurance/);
    expect(() => round.result()).toThrow(/not settled/);
    round.act('ann', 'stand');
    expect(() => {
      round.act('ann', 'hit');
    }).toThrow(/turn/);
  });
});

describe('double', () => {
  it('doubles the bet and deals exactly one more card', () => {
    const { round, deck } = deal({
      seats: [['6', '5']],
      dealer: ['6', '10'],
      then: ['3', '9', '4'],
    });
    round.act('ann', 'double');
    expect(round.phase).toBe('settled');
    expect(seatOf(round).hands).toMatchObject([
      { cards: [card('6'), card('5'), card('3')], total: 14, bet: 20, doubled: true },
    ]);
    expect(resultOf(round)).toMatchObject({
      hands: [{ outcome: 'win', bet: 20, payout: 40 }],
      staked: 20,
      payout: 40,
    });
    expect(deck.left).toBe(1);
  });

  it('is allowed after a split, unless the rules turn it off', () => {
    const allowed = deal({ seats: [['8', '8']], dealer: ['9', '7'], then: ['3'] }).round;
    allowed.act('ann', 'split');
    expect(actionsOf(allowed)).toEqual(['hit', 'stand', 'double']);

    const off = deal({
      seats: [['8', '8']],
      dealer: ['9', '7'],
      then: ['3'],
      rules: { doubleAfterSplit: false },
    }).round;
    off.act('ann', 'split');
    expect(actionsOf(off)).toEqual(['hit', 'stand']);
  });
});

describe('surrender', () => {
  it('returns half the bet, rounded down, and the dealer draws nothing for it', () => {
    const { round, deck } = deal({
      seats: [['10', '6']],
      dealer: ['10', '6'],
      then: ['5'],
      bets: [15],
    });
    round.act('ann', 'surrender');
    expect(round.phase).toBe('settled');
    expect(resultOf(round)).toEqual({
      id: 'ann',
      hands: [{ outcome: 'surrender', bet: 15, payout: 7 }],
      insurance: null,
      staked: 15,
      payout: 7,
    });
    expect(round.result().dealer.cards).toHaveLength(2);
    expect(deck.left).toBe(1);
  });

  it('is only offered on the first two cards of an unsplit hand', () => {
    const hit = deal({ seats: [['2', '3']], dealer: ['9', '7'], then: ['4'] }).round;
    hit.act('ann', 'hit');
    expect(actionsOf(hit)).not.toContain('surrender');

    const split = deal({ seats: [['7', '7']], dealer: ['9', '7'], then: ['9'] }).round;
    split.act('ann', 'split');
    expect(actionsOf(split)).toEqual(['hit', 'stand', 'double']);

    const off = deal({ seats: [['10', '6']], dealer: ['9', '7'], rules: { lateSurrender: false } });
    expect(actionsOf(off.round)).toEqual(['hit', 'stand', 'double']);
  });
});

describe('split', () => {
  it('gives split aces one card each, and 21 on a split ace pays 1:1', () => {
    const { round, deck } = deal({
      seats: [['A', 'A']],
      dealer: ['6', '10'],
      then: ['K', '5', '2'],
    });
    round.act('ann', 'split');
    expect(round.phase).toBe('settled');
    const { hands } = seatOf(round);
    expect(hands.map((hand) => ranks(hand.cards))).toEqual([
      ['A', 'K'],
      ['A', '5'],
    ]);
    expect(hands[0]).toMatchObject({ total: 21, blackjack: false });
    expect(resultOf(round)).toMatchObject({
      hands: [
        { outcome: 'win', bet: 10, payout: 20 },
        { outcome: 'lose', bet: 10, payout: 0 },
      ],
      staked: 20,
      payout: 20,
    });
    expect(deck.left).toBe(0);
  });

  it('never resplits aces', () => {
    const { round } = deal({ seats: [['A', 'A']], dealer: ['6', '10'], then: ['A', '9', '2'] });
    round.act('ann', 'split');
    expect(round.phase).toBe('settled');
    expect(seatOf(round).hands.map((hand) => ranks(hand.cards))).toEqual([
      ['A', 'A'],
      ['A', '9'],
    ]);
    expect(resultOf(round).hands.map((hand) => hand.outcome)).toEqual(['lose', 'win']);
  });

  it('resplits up to four hands, which are played in order', () => {
    const { round } = deal({
      seats: [['8', '8']],
      dealer: ['6', '10'],
      then: ['8', '8', '8', '2', '3', '4', '10'],
    });
    round.act('ann', 'split');
    round.act('ann', 'split');
    round.act('ann', 'split');
    expect(seatOf(round).hands).toHaveLength(4);
    expect(actionsOf(round)).toEqual(['hit', 'stand', 'double']);

    const turns: number[] = [];
    while (round.turn !== null) {
      turns.push(round.turn.hand);
      round.act('ann', 'stand');
    }
    expect(turns).toEqual([0, 1, 2, 3]);
    expect(seatOf(round).hands.map((hand) => ranks(hand.cards))).toEqual([
      ['8', '8'],
      ['8', '2'],
      ['8', '3'],
      ['8', '4'],
    ]);
    expect(round.result().dealer).toMatchObject({ total: 26, bust: true });
    expect(resultOf(round)).toMatchObject({ staked: 40, payout: 80 });
  });

  it('stops at the number of hands in the rules', () => {
    const { round } = deal({
      seats: [['8', '8']],
      dealer: ['9', '7'],
      then: ['8'],
      rules: { maxHands: 2 },
    });
    round.act('ann', 'split');
    expect(actionsOf(round)).toEqual(['hit', 'stand', 'double']);
  });
});

describe('the dealer draws nothing', () => {
  it('when the only hand busted', () => {
    const { round, deck } = deal({ seats: [['10', '6']], dealer: ['6', '10'], then: ['K', '5'] });
    round.act('ann', 'hit');
    expect(round.phase).toBe('settled');
    expect(seatOf(round).hands).toMatchObject([{ total: 26, bust: true }]);
    expect(round.result().dealer.cards).toHaveLength(2);
    expect(resultOf(round)).toMatchObject({ hands: [{ outcome: 'lose', payout: 0 }], payout: 0 });
    expect(deck.left).toBe(1);
  });

  it('when every split hand busted', () => {
    const { round, deck } = deal({
      seats: [['8', '8']],
      dealer: ['6', '10'],
      then: ['6', 'K', '7', 'Q', '9'],
    });
    round.act('ann', 'split');
    round.act('ann', 'hit');
    round.act('ann', 'hit');
    expect(round.phase).toBe('settled');
    expect(round.result().dealer.cards).toHaveLength(2);
    expect(resultOf(round).payout).toBe(0);
    expect(deck.left).toBe(1);
  });
});

describe('a timed-out turn', () => {
  it('stands on every hand the seat has left', () => {
    const { round, deck } = deal({
      seats: [['8', '8']],
      dealer: ['9', '8'],
      then: ['3', '10', '5'],
    });
    round.act('ann', 'split');
    round.standRemaining('ann');
    expect(round.phase).toBe('settled');
    const seat = seatOf(round);
    expect(seat.timedOut).toBe(true);
    expect(seat.hands.map((hand) => ranks(hand.cards))).toEqual([
      ['8', '3'],
      ['8', '10'],
    ]);
    expect(resultOf(round).hands.map((hand) => hand.outcome)).toEqual(['lose', 'win']);
    expect(deck.left).toBe(1);
  });
});

describe('the stake', () => {
  it('is the bet plus every raise: insurance, a split and a double', () => {
    const { round, deck } = deal({
      seats: [['8', '8']],
      dealer: ['A', '7'],
      then: ['3', '10', '9', '5'],
    });
    round.answerInsurance('ann', true);
    round.act('ann', 'split');
    expect(round.actions()).toContainEqual({ action: 'double', cost: 10 });
    round.act('ann', 'double');
    round.act('ann', 'stand');
    expect(resultOf(round)).toEqual({
      id: 'ann',
      hands: [
        { outcome: 'win', bet: 20, payout: 40 },
        { outcome: 'lose', bet: 10, payout: 0 },
      ],
      insurance: { cost: 5, payout: 0 },
      staked: 35,
      payout: 40,
    });
    expect(deck.left).toBe(1);
  });
});
