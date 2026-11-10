import {
  ButtonStyle,
  Colors,
  ComponentType,
  type APIButtonComponentWithCustomId,
} from 'discord.js';
import { describe, expect, it } from 'vitest';
import { gameConfig } from '../../src/config/game.js';
import type { BlackjackRound, PlayerAction } from '../../src/games/blackjack/index.js';
import { discordTimestamp } from '../../src/i18n/format.js';
import {
  blackjackBetModal,
  blackjackHelpEmbed,
  blackjackSeatReply,
  blackjackTableMessage,
  cardText,
  totalText,
  type RoundPlayer,
  type SeatLine,
  type TableMessage,
  type TableSnapshot,
  type TurnButton,
} from '../../src/ui/blackjack.js';
import { card, deal, type Layout } from '../games/blackjack/stack.js';
import { textOf } from '../helpers/discord.js';

const DEADLINE = Temporal.Instant.from('2026-11-09T12:00:20Z');

function snapshot(overrides: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    tableNumber: 12,
    phase: 'betting',
    closedReason: null,
    deadline: DEADLINE,
    seats: [],
    round: null,
    refund: null,
    cardsLeft: 287,
    turnButtons: [],
    customId: (action) => `bj:7:${action}:3`,
    ...overrides,
  };
}

function seatLine(number: number, name: string, overrides: Partial<SeatLine> = {}): SeatLine {
  return { number, name, bet: 100, status: 'noBet', sitOuts: 0, ...overrides };
}

const NAMES: Readonly<Record<string, string>> = { ann: 'Ann', bob: 'Bob', cy: 'Cy', dee: 'Dee' };

function players(round: BlackjackRound, settled?: Readonly<Record<string, number>>): RoundPlayer[] {
  const result = round.phase === 'settled' ? round.result() : null;
  return round.view().seats.map((seat, index) => {
    const outcome = result?.seats.find((candidate) => candidate.id === seat.id);
    return {
      id: seat.id,
      number: index + 1,
      name: NAMES[seat.id] ?? seat.id,
      net: outcome === undefined ? null : outcome.payout - outcome.staked,
      balance: settled?.[seat.id] ?? null,
    };
  });
}

function roundMessage(round: BlackjackRound, overrides: Partial<TableSnapshot> = {}): TableMessage {
  const view = round.view();
  const phase = view.phase === 'insurance' ? 'insurance' : 'turns';
  return blackjackTableMessage(
    'en',
    snapshot({ phase, round: { view, players: players(round), last: false }, ...overrides }),
  );
}

function settledMessage(layout: Layout, play: (round: BlackjackRound) => void): string {
  const { round } = deal(layout);
  play(round);
  const balances = { ann: 1_000, bob: 2_000 };
  const display = { view: round.view(), players: players(round, balances), last: true };
  return textOf(blackjackTableMessage('en', snapshot({ round: display })));
}

function buttons(message: TableMessage): APIButtonComponentWithCustomId[] {
  return message.components.flatMap((row) =>
    row.toJSON().components.flatMap((component) => ('custom_id' in component ? [component] : [])),
  );
}

function fieldValue(message: TableMessage, name: string): string {
  const field = message.embeds[0]?.toJSON().fields?.find((candidate) => candidate.name === name);
  if (field === undefined) throw new Error(`no field ${name}`);
  return field.value;
}

const turnButtons = (enabled: readonly PlayerAction[], cost = 10): TurnButton[] =>
  (['hit', 'stand', 'double', 'split', 'surrender'] as const).map((action) => ({
    action,
    cost: action === 'double' || action === 'split' ? cost : 0,
    enabled: enabled.includes(action),
  }));

describe('cards and totals (SPEC §7 display)', () => {
  it('writes cards with their suit', () => {
    expect(cardText('en', card('A', 'spades'))).toBe('A♠️');
    expect(cardText('en', card('10', 'hearts'))).toBe('10♥️');
    expect(cardText('en', card('Q', 'diamonds'))).toBe('Q♦️');
    expect(cardText('en', card('7', 'clubs'))).toBe('7♣️');
  });

  it('reads totals the way players do: "17", "soft 17", "Blackjack!" and "24, bust"', () => {
    const plain = { soft: false, blackjack: false, bust: false };
    expect(totalText('en', { ...plain, total: 17 })).toBe('17');
    expect(totalText('en', { ...plain, total: 17, soft: true })).toBe('soft 17');
    expect(totalText('en', { ...plain, total: 21, blackjack: true })).toBe('Blackjack!');
    expect(totalText('en', { ...plain, total: 24, bust: true })).toBe('24, bust');
  });
});

describe('the table during a turn', () => {
  const { round } = deal({
    seats: [
      ['10', '8'],
      ['A', '6'],
    ],
    dealer: ['7', '10'],
  });
  const message = roundMessage(round, {
    seats: [
      seatLine(1, 'Ann', { status: 'playing' }),
      seatLine(2, 'Bob', { status: 'playing' }),
      seatLine(3, 'Cy', { bet: 50, status: 'nextRound' }),
    ],
    turnButtons: turnButtons(['hit', 'stand', 'double', 'surrender']),
  });

  it('hides the hole card and marks the hand whose turn it is', () => {
    expect(fieldValue(message, 'Dealer')).toBe('7♠️ 🎴');
    expect(fieldValue(message, 'Seat 1')).toBe('**Ann**\n▶️ 10♠️ 8♠️ · 18 · 🪙 10');
    expect(fieldValue(message, 'Seat 2')).toBe('**Bob**\nA♠️ 6♠️ · soft 17 · 🪙 10');
  });

  it('says whose turn it is with the countdown, and lists every seat', () => {
    const text = textOf(message);
    expect(text).toMatch(
      new RegExp(
        `^It's \\*\\*Ann\\*\\*'s turn\\. Time runs out ${discordTimestamp(DEADLINE)}\\.$`,
        'm',
      ),
    );
    expect(text).toMatch(/^Seat 1 · \*\*Ann\*\* · 🪙 100 · 🃏 Playing$/m);
    expect(text).toMatch(/^Seat 3 · \*\*Cy\*\* · 🪙 50 · ⏳ Joins the next round$/m);
  });

  it('has one row of five turn buttons with the step in their custom IDs, off where not allowed', () => {
    expect(message.components).toHaveLength(1);
    expect(
      buttons(message).map((button) => [button.custom_id, button.label, button.disabled]),
    ).toEqual([
      ['bj:7:hit:3', 'Hit', false],
      ['bj:7:stand:3', 'Stand', false],
      ['bj:7:double:3', 'Double (🪙 10)', false],
      ['bj:7:split:3', 'Split (🪙 10)', true],
      ['bj:7:surrender:3', 'Surrender', false],
    ]);
    expect(buttons(message).map((button) => button.style)).toEqual([
      ButtonStyle.Primary,
      ButtonStyle.Secondary,
      ButtonStyle.Success,
      ButtonStyle.Success,
      ButtonStyle.Danger,
    ]);
  });

  it('summarises the rules and the cards left in the footer, in the in-progress colour', () => {
    const embed = message.embeds[0]?.toJSON();
    expect(embed?.footer?.text).toBe(
      '6 decks · Dealer stands on soft 17 · Blackjack pays 3:2 · 287 cards left in the shoe',
    );
    expect(embed?.color).toBe(Colors.Blurple);
    expect(embed?.title).toBe('🃏 Blackjack · Table #12');
  });
});

describe('the insurance question', () => {
  it('offers insurance with its cost and even money to a seat with blackjack', () => {
    const { round } = deal({
      seats: [
        ['10', '9'],
        ['A', 'K'],
      ],
      dealer: ['A', '7'],
    });
    const message = roundMessage(round);

    expect(buttons(message).map((button) => [button.custom_id, button.label])).toEqual([
      ['bj:7:insure:3', 'Insurance (🪙 5)'],
      ['bj:7:noInsure:3', 'No insurance'],
      ['bj:7:even:3', 'Even money'],
      ['bj:7:noEven:3', 'No even money'],
    ]);
    expect(fieldValue(message, 'Seat 1')).toMatch(/^Insurance\? \(🪙 5\)$/m);
    expect(fieldValue(message, 'Seat 2')).toMatch(/^Even money\?$/m);
    expect(textOf(message)).toMatch(/^The dealer shows an ace\. \*\*Insurance\?\*\* /m);
  });

  it('leaves the cost off when the seats would pay different amounts, and shows answers', () => {
    const { round } = deal({
      seats: [
        ['10', '9'],
        ['10', '8'],
        ['9', '9'],
      ],
      dealer: ['A', '7'],
      bets: [10, 40, 40],
    });
    round.answerInsurance('cy', false);
    const message = roundMessage(round);

    expect(buttons(message).map((button) => button.label)).toEqual(['Insurance', 'No insurance']);
    expect(fieldValue(message, 'Seat 3')).toMatch(/^No insurance$/m);
  });
});

describe('the settled round', () => {
  it('reveals the dealer and shows each result, the net result and the new balance', () => {
    const text = settledMessage({ seats: [['10', '8']], dealer: ['7', '10'] }, (round) => {
      round.act('ann', 'stand');
    });
    expect(text).toMatch(/^Dealer · last round\n7♠️ 10♠️ · 17$/m);
    expect(text).toMatch(/^10♠️ 8♠️ · 18 · 🪙 10 · ✅ Win$/m);
    expect(text).toMatch(/^Net \+🪙 10 · Balance 🪙 1,000$/m);
  });

  it('shows a doubled hand, a bust and a loss in red figures', () => {
    const text = settledMessage(
      {
        seats: [
          ['6', '5'],
          ['10', '6'],
        ],
        dealer: ['7', '10'],
        then: ['10', '8'],
      },
      (round) => {
        round.act('ann', 'double');
        round.act('bob', 'hit');
      },
    );
    expect(text).toMatch(/^6♠️ 5♠️ 10♠️ · 21 · 🪙 20, doubled · ✅ Win$/m);
    expect(text).toMatch(/^10♠️ 6♠️ 8♠️ · 24, bust · 🪙 10 · ❌ Lose$/m);
    expect(text).toMatch(/^Net -🪙 10 · Balance 🪙 2,000$/m);
  });

  it('pays a natural 3:2 and shows a push and a surrender', () => {
    const blackjack = settledMessage({ seats: [['A', 'K']], dealer: ['9', '7'] }, () => undefined);
    expect(blackjack).toMatch(/^A♠️ K♠️ · Blackjack! · 🪙 10 · 🎉 Paid 3:2$/m);
    expect(blackjack).toMatch(/^Net \+🪙 15 · Balance 🪙 1,000$/m);

    const others = settledMessage(
      {
        seats: [
          ['10', '7'],
          ['10', '6'],
        ],
        dealer: ['10', '7'],
      },
      (round) => {
        round.act('ann', 'stand');
        round.act('bob', 'surrender');
      },
    );
    expect(others).toMatch(/^10♠️ 7♠️ · 17 · 🪙 10 · ➖ Push$/m);
    expect(others).toMatch(/^Net 🪙 0 · Balance 🪙 1,000$/m);
    expect(others).toMatch(/^10♠️ 6♠️ · 16 · 🪙 10 · 🏳️ Surrendered$/m);
    expect(others).toMatch(/^Net -🪙 5 · Balance 🪙 2,000$/m);
  });

  it('shows insurance paid, insurance lost and even money', () => {
    const paid = settledMessage({ seats: [['10', '9']], dealer: ['A', 'K'] }, (round) => {
      round.answerInsurance('ann', true);
    });
    expect(paid).toMatch(/^Insurance paid 🪙 15$/m);
    expect(paid).toMatch(/^10♠️ 9♠️ · 19 · 🪙 10 · ❌ Lose$/m);
    expect(paid).toMatch(/^Net 🪙 0 · /m);

    const lost = settledMessage(
      {
        seats: [
          ['10', '9'],
          ['A', 'K'],
        ],
        dealer: ['A', '7'],
      },
      (round) => {
        round.answerInsurance('ann', true);
        round.answerInsurance('bob', true);
        round.act('ann', 'stand');
      },
    );
    expect(lost).toMatch(/^Insurance lost \(🪙 5\)$/m);
    expect(lost).toMatch(/^A♠️ K♠️ · Blackjack! · 🪙 10 · 💰 Even money$/m);
    expect(lost).not.toMatch(/^No insurance$/m);
  });

  it('notes that the bot stood for a player whose time ran out', () => {
    const text = settledMessage({ seats: [['10', '6']], dealer: ['7', '10'] }, (round) => {
      round.standRemaining('ann');
    });
    expect(text).toMatch(/^⏱️ Out of time: the bot stood automatically\.$/m);
  });
});

describe('the betting phase', () => {
  it('has Same bet with the amount, Change bet and Leave, and the countdown', () => {
    const message = blackjackTableMessage(
      'en',
      snapshot({
        seats: [seatLine(1, 'Ann', { bet: 1_500 }), seatLine(2, 'Bob', { status: 'betPlaced' })],
      }),
    );
    expect(buttons(message).map((button) => [button.custom_id, button.label])).toEqual([
      ['bj:7:same:3', 'Same bet (🪙 1,500)'],
      ['bj:7:change:3', 'Change bet'],
      ['bj:7:leave:3', 'Leave'],
    ]);
    const text = textOf(message);
    expect(text).toMatch(
      new RegExp(
        `^\\*\\*Place your bets!\\*\\* Betting closes ${discordTimestamp(DEADLINE)}\\.$`,
        'm',
      ),
    );
    expect(text).toMatch(/^Seat 1 · \*\*Ann\*\* · 🪙 1,500 · ⏳ No bet yet$/m);
    expect(text).toMatch(/^Seat 2 · \*\*Bob\*\* · 🪙 100 · ✅ Bet placed$/m);
  });

  it('leaves the amount off Same bet when the players still to bet have different bets', () => {
    const message = blackjackTableMessage(
      'en',
      snapshot({ seats: [seatLine(1, 'Ann', { bet: 10 }), seatLine(2, 'Bob', { bet: 20 })] }),
    );
    expect(buttons(message)[0]?.label).toBe('Same bet');
  });

  it('shows sit-outs and a player who leaves after the round', () => {
    const text = textOf(
      blackjackTableMessage(
        'en',
        snapshot({
          seats: [
            seatLine(1, 'Ann', { status: 'noBetSatOut', sitOuts: 1 }),
            seatLine(2, 'Bob', { status: 'leaving' }),
          ],
        }),
      ),
    );
    expect(text).toMatch(/^Seat 1 · \*\*Ann\*\* · 🪙 100 · ⏳ No bet yet · sat out 1\/2$/m);
    expect(text).toMatch(
      /^Seat 2 · \*\*Bob\*\* · 🪙 100 · 👋 Bet placed, leaves after this round$/m,
    );
  });

  it('escapes markdown in names, masked links included', () => {
    const text = textOf(
      blackjackTableMessage('en', snapshot({ seats: [seatLine(1, '**[free](https://x.y)**')] })),
    );
    expect(text).toContain('**\\*\\*\\[free](https://x.y)\\*\\***');
    expect(text).not.toMatch(/(?<!\\)\[free\]/);
  });
});

describe('a closed table', () => {
  it('says why, in grey, without buttons', () => {
    const restart = blackjackTableMessage(
      'en',
      snapshot({ phase: 'closed', closedReason: 'restart' }),
    );
    expect(restart.components).toEqual([]);
    expect(restart.embeds[0]?.toJSON().color).toBe(Colors.Grey);
    expect(textOf(restart)).toMatch(/closed for a restart\. Open stakes are refunded/);

    const empty = blackjackTableMessage('en', snapshot({ phase: 'closed', closedReason: 'empty' }));
    expect(textOf(empty)).toMatch(/^Every seat is empty, so this game of blackjack has ended\.$/m);
  });

  it('says what became of the stakes after a failed settlement, never "when the bot restarts"', () => {
    const closed = (refund: TableSnapshot['refund']): string =>
      textOf(
        blackjackTableMessage(
          'en',
          snapshot({ phase: 'closed', closedReason: 'settleFailed', refund }),
        ),
      );

    expect(closed('refunded')).toMatch(
      /^⚠️ This round could not be settled, so every stake was refunded and this game has ended\.$/m,
    );
    expect(closed('pending')).toMatch(
      /^⚠️ This round could not be settled, so this game has ended\. Its stakes come back to you automatically shortly\.$/m,
    );
    expect(closed('settled')).toMatch(
      /^⚠️ This round went through, but its result can't be shown, so this game has ended\. Check your coins with `\/balance`\.$/m,
    );
    for (const refund of ['refunded', 'pending', 'settled'] as const) {
      expect(closed(refund)).not.toMatch(/restart/);
    }
  });
});

describe('Discord limits', () => {
  it('stay within the embed and component limits at a full table of split hands', () => {
    const { round } = deal({
      seats: [
        ['8', '8'],
        ['8', '8'],
        ['8', '8'],
        ['8', '8'],
      ],
      dealer: ['6', '10'],
      then: ['8', '8', '8', '8', '8', '8'],
      bets: [1_000_000, 1_000_000, 1_000_000, 1_000_000],
    });
    for (let split = 0; split < 3; split += 1) round.act('ann', 'split');
    const long = 'N'.repeat(32);
    const message = roundMessage(round, {
      seats: [1, 2, 3, 4].map((number) => seatLine(number, long, { status: 'playing' })),
      turnButtons: turnButtons(['hit', 'stand', 'double'], 1_000_000),
    });
    const embed = message.embeds[0]?.toJSON();
    expect(embed?.description?.length).toBeLessThanOrEqual(4096);
    expect(embed?.fields?.length).toBeLessThanOrEqual(25);
    for (const field of embed?.fields ?? []) expect(field.value.length).toBeLessThanOrEqual(1024);
    expect(JSON.stringify(embed).length).toBeLessThan(6000);
    expect(message.components.length).toBeLessThanOrEqual(5);
    for (const row of message.components) expect(row.components.length).toBeLessThanOrEqual(5);
    for (const button of buttons(message)) {
      expect(button.label?.length).toBeLessThanOrEqual(80);
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('the Change bet modal', () => {
  it('asks for one amount, filled in with the current bet', () => {
    const modal = blackjackBetModal('en', 'bj:7:bet:2', 250).toJSON();
    expect(modal.custom_id).toBe('bj:7:bet:2');
    expect(modal.title).toBe('Change bet');
    expect(modal.components).toEqual([
      expect.objectContaining({
        type: ComponentType.Label,
        label: 'Your bet',
        component: expect.objectContaining({
          type: ComponentType.TextInput,
          custom_id: 'amount',
          value: '250',
          required: true,
        }) as unknown,
      }),
    ]);
  });
});

describe('the /blackjack confirmation', () => {
  it('names the seat and the bet, and links to the table', () => {
    const url = 'https://discord.com/channels/1/2/3';
    expect(blackjackSeatReply('en', { seat: 2, bet: 1_500, placed: true, url }, false)).toBe(
      `You have seat 2, with a bet of **🪙 1,500** on this round. [Go to the table](${url})`,
    );
    expect(blackjackSeatReply('en', { seat: 3, bet: 10, placed: false, url }, false)).toBe(
      `You have seat 3. Your bet for the next round is **🪙 10**: press **Same bet** when betting opens. [Go to the table](${url})`,
    );
  });

  it('says so when the table is in another channel', () => {
    const url = 'https://discord.com/channels/1/2/3';
    expect(blackjackSeatReply('en', { seat: 1, bet: 50, placed: true, url }, true)).toBe(
      `You have seat 1, with a bet of **🪙 50** on this round. This table is in another channel: [go to the table](${url}).`,
    );
  });
});

describe('blackjack help (SPEC §9)', () => {
  it('explains the rules, the seats and the buttons with the numbers from the config', () => {
    const text = textOf({ embeds: [blackjackHelpEmbed('en')] });
    const { blackjackTable, stakes } = gameConfig;
    expect(text).toMatch(/^6 decks, reshuffled once 75% of the shoe has been dealt\.$/m);
    expect(text).toMatch(/^The dealer stands on soft 17 /m);
    expect(text).toMatch(/^Blackjack pays 3:2\.$/m);
    expect(text).toMatch(/into up to 4 hands/);
    expect(text).toMatch(/^Surrender your first two cards/m);
    expect(text).toMatch(
      new RegExp(
        `^Every table is a thread named "Table #N", where up to ${blackjackTable.seats} players share a dealer\\. `,
        'm',
      ),
    );
    expect(text).toContain('else in a channel you can see, else at a new table here.');
    expect(text).toContain(
      'Between games a table shows a lobby, where the **Blackjack** button opens a bet form',
    );
    expect(text).toContain(`${blackjackTable.bettingSeconds} seconds of betting`);
    expect(text).toContain(`${blackjackTable.turnSeconds} seconds per hand`);
    expect(text).toContain(`${blackjackTable.insuranceSeconds} seconds to answer`);
    expect(text).toContain(`Sit out ${blackjackTable.maxSitOuts} rounds in a row`);
    expect(text).toContain(`A bet is 🪙 ${stakes.min} to 🪙 1,000,000`);
    for (const button of [
      'Hit',
      'Stand',
      'Double',
      'Split',
      'Surrender',
      'Same bet',
      'Change bet',
      'Leave',
    ]) {
      expect(text).toContain(`**${button}**`);
    }
  });
});
