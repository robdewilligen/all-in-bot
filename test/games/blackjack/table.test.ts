import { describe, expect, it } from 'vitest';
import { BlackjackRound, type PlayerAction } from '../../../src/games/blackjack/index.js';
import { card, deal, ranks, resultOf, RULES, seatOf, StackedDeck } from './stack.js';

describe('a round with several seats', () => {
  it('deals a card to every seat, the upcard, a second card to every seat, then the hole card', () => {
    const order = [
      card('2', 'clubs'),
      card('3', 'clubs'),
      card('4', 'clubs'),
      card('9', 'hearts'),
      card('5', 'clubs'),
      card('6', 'clubs'),
      card('7', 'clubs'),
      card('8', 'hearts'),
    ];
    const round = new BlackjackRound(RULES, new StackedDeck(order), [
      { id: 'ann', bet: 10 },
      { id: 'bob', bet: 20 },
      { id: 'cy', bet: 30 },
    ]);
    const view = round.view();
    expect(view.seats.map((seat) => seat.hands.map((hand) => hand.cards))).toEqual([
      [[card('2', 'clubs'), card('5', 'clubs')]],
      [[card('3', 'clubs'), card('6', 'clubs')]],
      [[card('4', 'clubs'), card('7', 'clubs')]],
    ]);
    expect(view.dealer.cards).toEqual([card('9', 'hearts')]);

    for (const id of ['ann', 'bob', 'cy']) round.act(id, 'stand');
    expect(round.result().dealer.cards).toEqual([card('9', 'hearts'), card('8', 'hearts')]);
    expect(round.result().seats.map((seat) => seat.staked)).toEqual([10, 20, 30]);
  });

  it('plays the seats in order, and the hands of each seat in order', () => {
    const { round } = deal({
      seats: [
        ['8', '8'],
        ['10', '2'],
        ['9', '7'],
      ],
      dealer: ['6', '10'],
      then: ['3', '4', '5', '10'],
    });
    const turns: string[] = [];
    const play = (action: PlayerAction): void => {
      const { turn } = round;
      if (turn === null) throw new Error('nobody is on turn');
      turns.push(`${turn.seatId} ${turn.hand}`);
      round.act(turn.seatId, action);
    };
    play('split');
    play('stand');
    play('stand');
    play('hit');
    play('stand');
    play('stand');
    expect(turns).toEqual(['ann 0', 'ann 0', 'ann 1', 'bob 0', 'bob 0', 'cy 0']);
    expect(round.phase).toBe('settled');
  });

  it('settles every seat against one dealer hand, played once after the last seat', () => {
    const { round, deck } = deal({
      seats: [
        ['10', '8'],
        ['10', '10'],
        ['10', '7'],
      ],
      dealer: ['10', '6'],
      then: ['2'],
    });
    round.act('ann', 'stand');
    round.act('bob', 'stand');
    expect(deck.left).toBe(1);
    round.act('cy', 'stand');
    const { dealer, seats } = round.result();
    expect(ranks(dealer.cards)).toEqual(['10', '6', '2']);
    expect(seats.map((seat) => seat.hands)).toEqual([
      [{ outcome: 'push', bet: 10, payout: 10 }],
      [{ outcome: 'win', bet: 10, payout: 20 }],
      [{ outcome: 'lose', bet: 10, payout: 0 }],
    ]);
    expect(deck.left).toBe(0);
  });

  it('draws nothing for the dealer when every hand at the table is finished', () => {
    const { round, deck } = deal({
      seats: [
        ['10', '6'],
        ['10', '6'],
        ['A', 'K'],
      ],
      dealer: ['10', '6'],
      then: ['K', '9'],
    });
    round.act('ann', 'hit');
    round.act('bob', 'surrender');
    expect(round.phase).toBe('settled');
    expect(round.result().dealer.cards).toHaveLength(2);
    expect(round.result().seats.map((seat) => seat.hands)).toEqual([
      [{ outcome: 'lose', bet: 10, payout: 0 }],
      [{ outcome: 'surrender', bet: 10, payout: 5 }],
      [{ outcome: 'blackjack', bet: 10, payout: 25 }],
    ]);
    expect(deck.left).toBe(1);
  });

  it('gives one seat even money while another takes insurance, against a dealer natural', () => {
    const { round } = deal({
      seats: [
        ['A', 'K'],
        ['10', '9'],
      ],
      dealer: ['A', 'K'],
    });
    expect(round.insuranceOffer('ann')).toEqual({ kind: 'evenMoney', cost: 0 });
    expect(round.insuranceOffer('bob')).toEqual({ kind: 'insurance', cost: 5 });
    round.answerInsurance('ann', true);
    expect(round.phase).toBe('insurance');
    expect(round.insuranceOffer('ann')).toBeNull();
    expect(() => {
      round.answerInsurance('ann', false);
    }).toThrow(/no open insurance/);
    round.answerInsurance('bob', true);
    expect(round.phase).toBe('settled');
    expect(round.result().seats).toEqual([
      {
        id: 'ann',
        hands: [{ outcome: 'evenMoney', bet: 10, payout: 20 }],
        insurance: null,
        staked: 10,
        payout: 20,
      },
      {
        id: 'bob',
        hands: [{ outcome: 'lose', bet: 10, payout: 0 }],
        insurance: { cost: 5, payout: 15 },
        staked: 15,
        payout: 15,
      },
    ]);
  });

  it('gives one seat even money while another takes insurance, without a dealer natural', () => {
    const { round } = deal({
      seats: [
        ['A', 'K'],
        ['10', '9'],
      ],
      dealer: ['A', '7'],
    });
    round.answerInsurance('bob', true);
    round.answerInsurance('ann', true);
    expect(round.turn).toEqual({ seatId: 'bob', hand: 0 });
    expect(seatOf(round, 'ann').hands[0]?.result).toEqual({
      outcome: 'evenMoney',
      bet: 10,
      payout: 20,
    });
    round.act('bob', 'stand');
    expect(round.result().seats).toEqual([
      {
        id: 'ann',
        hands: [{ outcome: 'evenMoney', bet: 10, payout: 20 }],
        insurance: null,
        staked: 10,
        payout: 20,
      },
      {
        id: 'bob',
        hands: [{ outcome: 'win', bet: 10, payout: 20 }],
        insurance: { cost: 5, payout: 0 },
        staked: 15,
        payout: 20,
      },
    ]);
  });

  it('closes insurance when time is up: a seat that did not answer has none', () => {
    const { round } = deal({
      seats: [
        ['10', '9'],
        ['10', '8'],
      ],
      dealer: ['A', 'K'],
    });
    round.answerInsurance('ann', true);
    round.closeInsurance();
    expect(resultOf(round, 'ann')).toMatchObject({ insurance: { cost: 5, payout: 15 } });
    expect(seatOf(round, 'bob').insurance).toMatchObject({ answer: 'declined' });
    expect(resultOf(round, 'bob')).toMatchObject({ insurance: null, staked: 10, payout: 0 });
  });

  it('moves on to the next seat when a turn times out', () => {
    const { round } = deal({
      seats: [
        ['10', '2'],
        ['10', '9'],
      ],
      dealer: ['9', '8'],
    });
    round.standRemaining('ann');
    expect(round.turn).toEqual({ seatId: 'bob', hand: 0 });
    expect(seatOf(round, 'ann').timedOut).toBe(true);
    expect(seatOf(round, 'bob').timedOut).toBe(false);
    expect(() => {
      round.standRemaining('ann');
    }).toThrow(/turn/);
  });

  it('shows every hand as data, and the hole card once the round is settled', () => {
    const { round } = deal({
      seats: [
        ['A', '6'],
        ['A', 'K'],
      ],
      dealer: ['9', '7'],
      then: ['2'],
    });
    const view = round.view();
    expect(view.phase).toBe('turns');
    expect(view.turn).toEqual({ seatId: 'ann', hand: 0 });
    expect(view.dealer).toEqual({
      cards: [card('9')],
      holeCardHidden: true,
      total: 9,
      soft: false,
      blackjack: false,
      bust: false,
    });
    expect(view.seats).toEqual([
      {
        id: 'ann',
        hands: [
          {
            cards: [card('A'), card('6')],
            total: 17,
            soft: true,
            blackjack: false,
            bust: false,
            bet: 10,
            doubled: false,
            result: null,
          },
        ],
        insurance: null,
        timedOut: false,
        staked: 10,
      },
      {
        id: 'bob',
        hands: [
          {
            cards: [card('A'), card('K')],
            total: 21,
            soft: true,
            blackjack: true,
            bust: false,
            bet: 10,
            doubled: false,
            result: { outcome: 'blackjack', bet: 10, payout: 25 },
          },
        ],
        insurance: null,
        timedOut: false,
        staked: 10,
      },
    ]);

    round.act('ann', 'stand');
    expect(round.view()).toMatchObject({
      phase: 'settled',
      turn: null,
      dealer: { cards: [card('9'), card('7'), card('2')], holeCardHidden: false, total: 18 },
    });
  });

  it('refuses seats without a positive whole bet or with the same id', () => {
    const deck = new StackedDeck([]);
    expect(() => new BlackjackRound(RULES, deck, [])).toThrow(RangeError);
    expect(() => new BlackjackRound(RULES, deck, [{ id: 'ann', bet: 0 }])).toThrow(RangeError);
    expect(() => new BlackjackRound(RULES, deck, [{ id: 'ann', bet: 2.5 }])).toThrow(RangeError);
    expect(
      () =>
        new BlackjackRound(RULES, deck, [
          { id: 'ann', bet: 10 },
          { id: 'ann', bet: 10 },
        ]),
    ).toThrow(RangeError);
  });
});
