import { randomInt } from 'node:crypto';
import {
  Collection,
  type ActionRowBuilder,
  type APIButtonComponentWithCustomId,
  type ButtonBuilder,
  type ModalBuilder,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlackjackTable } from '../../../src/bot/tables/blackjack-table.js';
import type { LiveTable } from '../../../src/bot/tables/registry.js';
import type { TableParent } from '../../../src/bot/tables/thread.js';
import type { Command } from '../../../src/bot/types.js';
import blackjack from '../../../src/commands/games/blackjack.js';
import { gameConfig } from '../../../src/config/game.js';
import { PlayerError } from '../../../src/core/errors.js';
import { TableRoundClosedError, type SettledRound } from '../../../src/core/wallet.js';
import interactionCreate from '../../../src/events/interaction-create.js';
import type { Card, Rank } from '../../../src/games/blackjack/index.js';
import { discordTimestamp, formatCoins } from '../../../src/i18n/format.js';
import { translate } from '../../../src/i18n/index.js';
import { captureLogs, fakeContext, FIXED_NOW, type FakeContext } from '../../helpers/context.js';
import {
  CHANNEL_ID,
  contentOf,
  discordError,
  FakeChannel,
  fakeButton,
  fakeChatInput,
  fakeModalSubmit,
  fakeUser,
  GUILD_ID,
  isEphemeral,
  textOf,
  type FakeCollector,
  type FakeMessage,
  type FakeUser,
  type ResponseCall,
} from '../../helpers/discord.js';
import type { FakeHost } from '../../helpers/tables.js';

// The cards every table deals, in order, and the shoes the tables made.
const { stack, shoes } = vi.hoisted(() => ({
  stack: [] as Card[],
  shoes: [] as { draw: unknown; reshuffleDue: boolean; shuffles: number }[],
}));

vi.mock('../../../src/games/blackjack/index.js', async (importOriginal) => {
  const engine = await importOriginal<typeof import('../../../src/games/blackjack/index.js')>();
  class StackedShoe {
    reshuffleDue = false;
    shuffles = 0;
    readonly draw: unknown;

    constructor(_rules: unknown, draw: unknown) {
      this.draw = draw;
      shoes.push(this);
    }

    get cardsLeft(): number {
      return stack.length;
    }

    shuffle(): void {
      this.shuffles += 1;
      this.reshuffleDue = false;
    }

    deal(): Card {
      const next = stack.shift();
      if (next === undefined) throw new Error('the stacked shoe ran out');
      return next;
    }
  }
  return { ...engine, Shoe: StackedShoe };
});

const ALICE = fakeUser('200000000000000001', 'alice', 'Alice');
const BOB = fakeUser('200000000000000002', 'bob', 'Bob');
const CY = fakeUser('200000000000000003', 'cy', 'Cy');
const DEE = fakeUser('200000000000000004', 'dee', 'Dee');
const EVE = fakeUser('200000000000000005', 'eve', 'Eve');

const { bettingSeconds, insuranceSeconds, turnSeconds } = gameConfig.blackjackTable;
const commands = new Collection<string, Command>([['blackjack', blackjack]]);

/** Stacks one round in SPEC §7 dealing order: first cards, upcard, second cards, hole card, draws. */
function stackRound(
  seats: readonly (readonly [Rank, Rank])[],
  dealer: readonly [Rank, Rank],
  then: readonly Rank[] = [],
): void {
  const ranks = [
    ...seats.map(([first]) => first),
    dealer[0],
    ...seats.map(([, second]) => second),
    dealer[1],
    ...then,
  ];
  stack.push(...ranks.map((rank): Card => ({ rank, suit: 'spades' })));
}

function short(needed: number, balance: number): PlayerError {
  return new PlayerError('errors.insufficientFunds', {
    needed: formatCoins(needed),
    balance: formatCoins(balance),
  });
}

interface OpenRound {
  readonly userId: string;
  readonly tableRoundId: number;
  stake: number;
}

/**
 * A wallet that keeps real balances, so tests can follow every coin. Like the database's unique
 * index, it refuses a second open round for a player.
 */
class Bank {
  readonly balances = new Map<string, number>();
  readonly open = new Map<number, OpenRound>();
  #tableRounds = 100;
  #rounds = 0;

  constructor(context: FakeContext) {
    for (const user of [ALICE, BOB, CY, DEE, EVE]) this.balances.set(user.id, 1_000);
    const { wallet } = context;
    wallet.balanceOf.mockImplementation((player) => Promise.resolve(this.balanceOf(player.userId)));
    wallet.openTableRound.mockImplementation(() => {
      this.#tableRounds += 1;
      return Promise.resolve(this.#tableRounds);
    });
    wallet.openRound.mockImplementation((player, tableRoundId, stake) => {
      if ([...this.open.values()].some((round) => round.userId === player.userId)) {
        return Promise.reject(new Error('duplicate key value violates "rounds_one_open_per_game"'));
      }
      const balance = this.balanceOf(player.userId);
      if (balance < stake) return Promise.reject(short(stake, balance));
      this.balances.set(player.userId, balance - stake);
      this.#rounds += 1;
      this.open.set(this.#rounds, { userId: player.userId, tableRoundId, stake });
      return Promise.resolve({ roundId: this.#rounds, stake, balance: balance - stake });
    });
    wallet.raiseRound.mockImplementation((roundId, amount) => {
      const round = this.roundOf(roundId);
      const balance = this.balanceOf(round.userId);
      if (balance < amount) return Promise.reject(short(amount, balance));
      this.balances.set(round.userId, balance - amount);
      round.stake += amount;
      return Promise.resolve({ roundId, stake: round.stake, balance: balance - amount });
    });
    wallet.settleTableRound.mockImplementation((_tableRoundId, _outcome, settlements) =>
      Promise.resolve(this.settle(settlements)),
    );
    wallet.refundTableRound.mockImplementation((tableRoundId) => {
      let coins = 0;
      let rounds = 0;
      for (const [roundId, round] of this.open) {
        if (round.tableRoundId !== tableRoundId) continue;
        this.balances.set(round.userId, this.balanceOf(round.userId) + round.stake);
        this.open.delete(roundId);
        coins += round.stake;
        rounds += 1;
      }
      return Promise.resolve({ rounds, tableRounds: 1, coins });
    });
  }

  balanceOf(userId: string): number {
    return this.balances.get(userId) ?? 0;
  }

  roundOf(roundId: number): OpenRound {
    const round = this.open.get(roundId);
    if (round === undefined) throw new Error(`round ${String(roundId)} is not open`);
    return round;
  }

  settle(settlements: readonly { roundId: number; payout: number }[]): SettledRound[] {
    return settlements.map(({ roundId, payout }) => {
      const round = this.roundOf(roundId);
      const balance = this.balanceOf(round.userId) + payout;
      this.balances.set(round.userId, balance);
      this.open.delete(roundId);
      return { roundId, userId: round.userId, stake: round.stake, payout, balance };
    });
  }
}

interface Harness {
  readonly context: FakeContext;
  readonly channel: FakeChannel;
  readonly bank: Bank;
}

function setUp(context: FakeContext = fakeContext()): Harness {
  return { context, channel: new FakeChannel(), bank: new Bank(context) };
}

/** Lets every queued press, command and wallet answer run, without moving the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Runs /blackjack in the channel or table thread, but doesn't wait for it to finish. */
function startSit(
  h: Harness,
  user: FakeUser,
  bet: string,
  channel: FakeChannel = h.channel,
  hiddenChannels?: readonly string[],
): { readonly done: Promise<void>; readonly calls: ResponseCall[] } {
  const { interaction, calls } = fakeChatInput('blackjack', {
    user,
    channel,
    commands,
    hiddenChannels,
    strings: { bet },
  });
  return { done: interactionCreate.execute(h.context, interaction), calls };
}

async function sit(
  h: Harness,
  user: FakeUser,
  bet: string,
  channel: FakeChannel = h.channel,
  hiddenChannels?: readonly string[],
): Promise<ResponseCall[]> {
  const { done, calls } = startSit(h, user, bet, channel, hiddenChannels);
  await done;
  await flush();
  return calls;
}

/** The table message of the index-th table thread opened in the harness channel. */
function tableMessage(h: Harness, index = 0): FakeMessage {
  const message = h.channel.allMessages[index];
  if (message === undefined) throw new Error(`table ${String(index + 1)} has no message`);
  return message;
}

function hostOf(h: Harness, index = 0): FakeHost {
  const host = h.context.hosts.opened[index];
  if (host === undefined) throw new Error(`no table thread ${String(index + 1)} was opened`);
  return host;
}

/** A table thread between games, as /create-table opens it. */
async function lobby(h: Harness, channel: FakeChannel = h.channel): Promise<FakeHost> {
  await h.context.hosts.open({
    context: h.context,
    parent: channel as unknown as TableParent,
    game: null,
    locale: 'en-US',
    userId: ALICE.id,
  });
  const host = h.context.hosts.opened.at(-1);
  if (host === undefined) throw new Error('the lobby did not open');
  return host;
}

/** A roulette spin as far as the registry and a table thread see it. */
function rouletteGame(host: FakeHost): LiveTable {
  return {
    id: 'r-1',
    game: 'roulette',
    guildId: host.guildId,
    channelId: host.channelId,
    hasRoom: () => true,
    close: () => Promise.resolve(),
  };
}

function collectorOf(message: FakeMessage): FakeCollector {
  const [collector] = message.collectors;
  if (collector === undefined) throw new Error('the table message has no collector');
  return collector;
}

function tableOf(h: Harness, user: FakeUser): BlackjackTable | undefined {
  const table = h.context.tables.tableOf('blackjack', GUILD_ID, user.id);
  return table instanceof BlackjackTable ? table : undefined;
}

function buttonsOf(payload: unknown): APIButtonComponentWithCustomId[] {
  const { components = [] } = payload as {
    components?: readonly ActionRowBuilder<ButtonBuilder>[];
  };
  return components.flatMap((row) =>
    row.toJSON().components.flatMap((component) => ('custom_id' in component ? [component] : [])),
  );
}

const labels = (message: FakeMessage): (string | undefined)[] =>
  buttonsOf(message.latest).map((button) => button.label);

function customIdOf(message: FakeMessage, action: string): string {
  const button = buttonsOf(message.latest).find(
    (candidate) => candidate.custom_id.split(':')[2] === action,
  );
  if (button === undefined) throw new Error(`the table has no ${action} button`);
  return button.custom_id;
}

function pressOnce(message: FakeMessage, user: FakeUser, customId: string): ResponseCall[] {
  const { interaction, calls } = fakeButton(customId, { message, user });
  collectorOf(message).collect(interaction);
  return calls;
}

async function press(
  message: FakeMessage,
  user: FakeUser,
  action: string,
): Promise<ResponseCall[]> {
  const calls = pressOnce(message, user, customIdOf(message, action));
  await flush();
  return calls;
}

const methods = (calls: readonly ResponseCall[]): string[] => calls.map((call) => call.method);

/** The ephemeral texts sent, without the ephemeral deferral that carries none. */
function ephemeral(calls: readonly ResponseCall[]): string[] {
  return calls
    .filter((call) => call.method !== 'deferReply' && isEphemeral(call.options))
    .map((call) => contentOf(call.options) ?? '');
}

const countdown = (seconds: number): string =>
  discordTimestamp(FIXED_NOW.add({ seconds })).replace(/[:<>]/g, '\\$&');

/** Alice plays a round alone while Bob sits down; she wins it with 18 against 17. */
async function aliceThenBob(h: Harness): Promise<FakeMessage> {
  stackRound([['10', '8']], ['7', '10']);
  await sit(h, ALICE, '100');
  await sit(h, BOB, '50');
  const message = tableMessage(h);
  await press(message, ALICE, 'stand');
  return message;
}

/** Then they both bet the same again, which deals this round at once. */
async function bothBet(h: Harness, round: () => void): Promise<FakeMessage> {
  const message = await aliceThenBob(h);
  round();
  await press(message, ALICE, 'same');
  await press(message, BOB, 'same');
  return message;
}

beforeEach(() => {
  vi.useFakeTimers();
  stack.length = 0;
  shoes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('taking seats (SPEC §7)', () => {
  it('opens a table thread for the first player and deals at once, since everyone seated has bet', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);

    const calls = await sit(h, ALICE, '100');

    expect(h.channel.messages).toEqual([]);
    expect(h.channel.threadsStarted.map((thread) => thread.name)).toEqual(['Table #1 (Blackjack)']);
    const host = hostOf(h);
    const message = tableMessage(h);
    expect(host.thread.messages).toEqual([message]);
    expect(host.begun).toEqual([tableOf(h, ALICE)]);
    expect([...host.players]).toEqual([ALICE.id]);
    expect(h.context.hosts.open.mock.calls).toEqual([
      [expect.objectContaining({ game: 'blackjack', locale: 'en-US', userId: ALICE.id })],
    ]);
    expect(h.context.wallet.openTableRound.mock.calls).toEqual([[GUILD_ID, 'blackjack']]);
    expect(h.context.wallet.openRound.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: ALICE.id, displayName: 'Alice' }, 101, 100],
    ]);
    expect(contentOf(calls.at(-1)?.options)).toBe(
      `You have seat 1, with a bet of **🪙 100** on this round. [Go to the table](${message.url})`,
    );
    expect(stack).toEqual([]);
    expect(textOf(message.latest)).toMatch(/^🃏 Blackjack · Table #1$/m);
    expect(textOf(message.latest)).toMatch(
      new RegExp(
        `^It's \\*\\*Alice\\*\\*'s turn\\. Time runs out ${countdown(turnSeconds)}\\.$`,
        'm',
      ),
    );
    expect(labels(message)).toEqual([
      'Hit',
      'Stand',
      'Double (🪙 100)',
      'Split (🪙 100)',
      'Surrender',
    ]);
    expect(buttonsOf(message.latest).map((button) => button.disabled)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it('seats four players at one table, and opens a second table thread for the fifth', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    for (const user of [BOB, CY, DEE]) await sit(h, user, '50');
    stackRound([['9', '8']], ['6', '10']);

    const eve = await sit(h, EVE, '50');

    expect(h.channel.threadsStarted.map((thread) => thread.name)).toEqual([
      'Table #1 (Blackjack)',
      'Table #2 (Blackjack)',
    ]);
    expect(h.channel.messages).toEqual([]);
    const first = tableOf(h, ALICE);
    expect([BOB, CY, DEE].map((user) => tableOf(h, user))).toEqual([first, first, first]);
    expect([...hostOf(h).players]).toEqual([ALICE.id, BOB.id, CY.id, DEE.id]);
    expect(first?.hasRoom()).toBe(false);
    expect(tableOf(h, EVE)).not.toBe(first);
    expect(textOf(tableMessage(h).latest)).toMatch(
      /^Seat 4 · \*\*Dee\*\* · 🪙 50 · ⏳ Joins the next round$/m,
    );
    expect(contentOf(eve.at(-1)?.options)).toContain(`(${tableMessage(h, 1).url})`);
  });

  it('places the first bet before the thread opens, so a refused bet leaves nothing behind (finding 6)', async () => {
    const h = setUp();
    h.context.wallet.openRound.mockRejectedValueOnce(new Error('connection lost'));

    const calls = await sit(h, ALICE, '100');

    expect(h.context.hosts.open).not.toHaveBeenCalled();
    expect(h.channel.threadsStarted).toEqual([]);
    expect(h.channel.allMessages).toEqual([]);
    expect(ephemeral(calls)).toEqual([translate('en-US', ['errors.generic'])]);
    expect(tableOf(h, ALICE)).toBeUndefined();
    expect(h.context.tables.all()).toEqual([]);
    // The table round it opened has no bets; it is closed rather than left open.
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[101]]);

    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    expect(h.channel.threadsStarted).toHaveLength(1);
    expect(tableOf(h, ALICE)).toBeDefined();
  });

  it('refunds the first bet and closes the new thread when its table message fails', async () => {
    const h = setUp();
    const open = h.context.hosts.open.getMockImplementation();
    h.context.hosts.open.mockImplementationOnce(async (options) => {
      if (open === undefined) throw new Error('fakeHosts().open has no implementation');
      const host = (await open(options)) as FakeHost;
      host.thread.sendError = discordError(50013, 403);
      return host;
    });

    const calls = await sit(h, ALICE, '100');

    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[101]]);
    expect(h.bank.balanceOf(ALICE.id)).toBe(1_000);
    expect(hostOf(h).closeCalls).toBe(1);
    expect(hostOf(h).thread.archived).toBe(true);
    expect(h.channel.allMessages).toEqual([]);
    expect(tableOf(h, ALICE)).toBeUndefined();
    expect(h.context.tables.all()).toEqual([]);
    expect(ephemeral(calls)).toEqual([translate('en-US', ['errors.generic'])]);
  });
});

describe('seating in table threads (SPEC §4)', () => {
  it('starts blackjack at a table between games when /blackjack is used in its thread', async () => {
    const h = setUp();
    const host = await lobby(h);
    stackRound([['10', '8']], ['7', '10']);

    const calls = await sit(h, BOB, '100', host.thread);

    expect(h.channel.threadsStarted).toEqual([host.thread]);
    expect(h.context.hosts.open).toHaveBeenCalledTimes(1);
    const table = tableOf(h, BOB);
    expect(host.begun).toEqual([table]);
    expect(host.game).toBe(table);
    expect(host.players.has(BOB.id)).toBe(true);
    const [message] = host.thread.messages;
    expect(textOf(message?.latest)).toMatch(/^It's \*\*Bob\*\*'s turn\./m);
    expect(contentOf(calls.at(-1)?.options)).toBe(
      `You have seat 1, with a bet of **🪙 100** on this round. [Go to the table](${message?.url ?? ''})`,
    );
  });

  it('refunds the first bet and hands the table back to its lobby when the game message fails', async () => {
    const h = setUp();
    const host = await lobby(h);
    host.thread.sendError = discordError(50013, 403);

    const calls = await sit(h, BOB, '100', host.thread);

    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[101]]);
    expect(h.bank.balanceOf(BOB.id)).toBe(1_000);
    expect(host.begun).toHaveLength(1);
    expect(host.ends).toEqual([{ game: host.begun[0], reason: 'over' }]);
    expect(host.closeCalls).toBe(0);
    expect(host.game).toBeNull();
    expect(tableOf(h, BOB)).toBeUndefined();
    expect(ephemeral(calls)).toEqual([translate('en-US', ['errors.generic'])]);
  });

  it('joins the game of the thread it is used in, not the first table with room', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const second = await lobby(h);
    stackRound([['9', '8']], ['6', '10']);
    await sit(h, BOB, '100', second.thread);

    await sit(h, CY, '50', second.thread);

    expect(tableOf(h, CY)).toBe(tableOf(h, BOB));
    expect(tableOf(h, CY)).not.toBe(tableOf(h, ALICE));
    expect(second.players.has(CY.id)).toBe(true);
  });

  it('refuses /blackjack in a thread that plays roulette, before any money moves', async () => {
    const h = setUp();
    const host = await lobby(h);
    host.begin(rouletteGame(host));

    const calls = await sit(h, BOB, '100', host.thread);

    expect(ephemeral(calls)).toEqual([
      'Table #1 is playing Roulette right now. Wait for this game to end, or use `/blackjack` outside this thread.',
    ]);
    expect(h.context.wallet.openTableRound.mock.calls).toEqual([]);
    expect(h.context.wallet.openRound.mock.calls).toEqual([]);
    expect(h.channel.threadsStarted).toHaveLength(1);
    expect(tableOf(h, BOB)).toBeUndefined();
  });

  it('says the thread has no room when its game is full', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    for (const user of [BOB, CY, DEE]) await sit(h, user, '50');

    const calls = await sit(h, EVE, '50', hostOf(h).thread);

    expect(ephemeral(calls)).toEqual([
      'Table #1 has no room. Use `/blackjack` outside this thread to find another table.',
    ]);
    expect(h.channel.threadsStarted).toHaveLength(1);
    expect(tableOf(h, EVE)).toBeUndefined();
  });

  it('never seats a player at a table in a channel they cannot see', async () => {
    const h = setUp();
    const hidden = new FakeChannel('300000000000000009');
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100', hidden);
    stackRound([['9', '8']], ['6', '10']);

    await sit(h, BOB, '50', h.channel, [hidden.id]);
    await sit(h, CY, '50', new FakeChannel('300000000000000008'));

    expect(tableOf(h, BOB)).not.toBe(tableOf(h, ALICE));
    expect(h.channel.threadsStarted).toHaveLength(1);
    expect(tableOf(h, BOB)?.channelId).toBe(CHANNEL_ID);
    // Cy sees every channel, so the oldest table with room elsewhere takes him.
    expect(tableOf(h, CY)).toBe(tableOf(h, ALICE));
  });
});

describe('betting (SPEC §7)', () => {
  it('starts the next betting phase after the settlement, with Same bet, Change bet and Leave', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);

    expect(labels(message)).toEqual(['Same bet', 'Change bet', 'Leave']);
    expect(textOf(message.latest)).toMatch(
      new RegExp(
        `^\\*\\*Place your bets!\\*\\* Betting closes ${countdown(bettingSeconds)}\\.$`,
        'm',
      ),
    );
    expect(textOf(message.latest)).toMatch(/^Net \+🪙 100 · Balance 🪙 1,100$/m);
  });

  it('ends early once every seated player has bet', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    stackRound(
      [
        ['10', '9'],
        ['10', '7'],
      ],
      ['8', '10'],
    );

    await press(message, ALICE, 'same');
    expect(stack).toHaveLength(6);
    expect(textOf(message.latest)).toMatch(/^Seat 1 · \*\*Alice\*\* · 🪙 100 · ✅ Bet placed$/m);
    expect(textOf(message.latest)).toMatch(/^Seat 2 · \*\*Bob\*\* · 🪙 50 · ⏳ No bet yet$/m);

    await press(message, BOB, 'same');
    expect(stack).toEqual([]);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Alice\*\*'s turn\./m);
    expect(
      h.context.wallet.openRound.mock.calls.map(([player, table, stake]) => [
        player.userId,
        table,
        stake,
      ]),
    ).toEqual([
      [ALICE.id, 101, 100],
      [ALICE.id, 102, 100],
      [BOB.id, 102, 50],
    ]);
  });

  it('places the bet of a player who sits down while betting runs, and adds them to the thread', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    await press(message, ALICE, 'stand');

    const calls = await sit(h, BOB, '50');

    expect(contentOf(calls.at(-1)?.options)).toMatch(
      /^You have seat 2, with a bet of \*\*🪙 50\*\* on this round\. /,
    );
    expect(h.context.wallet.openRound.mock.calls.at(-1)?.slice(1)).toEqual([102, 50]);
    expect(textOf(message.latest)).toMatch(/^Seat 2 · \*\*Bob\*\* · 🪙 50 · ✅ Bet placed$/m);
    expect(textOf(message.latest)).toMatch(/^\*\*Place your bets!\*\*/m);
    expect([...hostOf(h).players]).toEqual([ALICE.id, BOB.id]);
  });

  it('deals the players who bet when time runs out, and the others sit out', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    stackRound([['10', '9']], ['8', '10']);
    await press(message, BOB, 'same');

    await vi.advanceTimersByTimeAsync(bettingSeconds * 1000 - 1);
    expect(stack).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);

    expect(stack).toEqual([]);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Bob\*\*'s turn\./m);
    expect(textOf(message.latest)).toMatch(
      /^Seat 1 · \*\*Alice\*\* · 🪙 100 · 💤 Sitting out · 1\/2$/m,
    );
  });

  it('takes the seat after two rounds in a row without a bet, and ends the empty game', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    await press(message, ALICE, 'stand');

    await vi.advanceTimersByTimeAsync(bettingSeconds * 1000);
    expect(textOf(message.latest)).toMatch(
      /^Seat 1 · \*\*Alice\*\* · 🪙 100 · ⏳ No bet yet · sat out 1\/2$/m,
    );
    expect(labels(message)).toEqual(['Same bet (🪙 100)', 'Change bet', 'Leave']);
    expect(tableOf(h, ALICE)).toBeDefined();
    expect(hostOf(h).ends).toEqual([]);

    await vi.advanceTimersByTimeAsync(bettingSeconds * 1000);
    expect(textOf(message.latest)).toMatch(
      /^Every seat is empty, so this game of blackjack has ended\.$/m,
    );
    expect(buttonsOf(message.latest)).toEqual([]);
    expect(tableOf(h, ALICE)).toBeUndefined();
    expect(h.context.tables.all()).toEqual([]);
    expect(collectorOf(message).ended).toBe(true);
    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
    // The lobby takes over; the game never archives the thread itself.
    const table = hostOf(h).begun[0];
    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'over' }]);
    expect(hostOf(h).thread.archiveCalls).toEqual([]);

    const edits = message.edits.length;
    await vi.advanceTimersByTimeAsync(10 * bettingSeconds * 1000);
    expect(message.edits).toHaveLength(edits);
  });

  it('ends the game when the last seat leaves, and the lobby takes over', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    await press(message, ALICE, 'stand');
    const table = tableOf(h, ALICE);

    await press(message, ALICE, 'leave');

    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'over' }]);
    expect(hostOf(h).closeCalls).toBe(0);
    expect(textOf(message.latest)).toMatch(
      /^Every seat is empty, so this game of blackjack has ended\.$/m,
    );
    expect(h.context.tables.all()).toEqual([]);
  });

  it('lets a player without a bet leave at once, which deals the others if they all bet', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    stackRound([['10', '9']], ['8', '10']);
    await press(message, ALICE, 'same');

    await press(message, BOB, 'leave');

    expect(tableOf(h, BOB)).toBeUndefined();
    expect(textOf(message.latest)).not.toMatch(/Bob/);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Alice\*\*'s turn\./m);
  });

  it('lets a player who already bet leave once the round is over', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    stackRound(
      [
        ['10', '9'],
        ['10', '7'],
      ],
      ['8', '10'],
    );
    await press(message, ALICE, 'same');

    const leave = await press(message, ALICE, 'leave');
    expect(ephemeral(leave)).toEqual([
      "Your bet for this round is placed, so you'll leave the table when the round ends.",
    ]);
    expect(textOf(message.latest)).toMatch(
      /^Seat 1 · \*\*Alice\*\* · 🪙 100 · 👋 Bet placed, leaves after this round$/m,
    );

    await press(message, BOB, 'same');
    expect(tableOf(h, ALICE)).toBeDefined();
    await press(message, ALICE, 'stand');
    await press(message, BOB, 'stand');

    expect(tableOf(h, ALICE)).toBeUndefined();
    expect(tableOf(h, BOB)).toBeDefined();
    const text = textOf(message.latest);
    expect(text).not.toMatch(/^Seat \d · \*\*Alice\*\*/m);
    expect(text).toMatch(
      /^\*\*Alice\*\*\n10♠️ 9♠️ · 19 · 🪙 100 · ✅ Win\nNet \+🪙 100 · Balance 🪙 1,200$/m,
    );
  });

  it("keeps a seated player's /blackjack bet for the next round, or places it while betting runs", async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);

    const during = await sit(h, ALICE, '200');
    expect(contentOf(during.at(-1)?.options)).toMatch(
      /^You have seat 1\. Your bet for the next round is \*\*🪙 200\*\*: /,
    );
    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
    expect(h.channel.allMessages).toHaveLength(1);

    await press(message, ALICE, 'stand');
    expect(labels(message)).toEqual(['Same bet (🪙 200)', 'Change bet', 'Leave']);
    stackRound([['10', '9']], ['8', '10']);

    const betting = await sit(h, ALICE, '300');
    expect(contentOf(betting.at(-1)?.options)).toMatch(
      /^You have seat 1, with a bet of \*\*🪙 300\*\* on this round\. /,
    );
    expect(h.context.wallet.openRound.mock.calls.at(-1)?.slice(1)).toEqual([102, 300]);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Alice\*\*'s turn\./m);
  });

  it('tells someone without a seat how to sit down', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);

    const calls = await press(message, EVE, 'same');

    expect(ephemeral(calls)).toEqual([
      "You don't have a seat at this table. Use `/blackjack` to sit down.",
    ]);
    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
  });

  it('refuses Same bet the player can no longer afford, and the seat stays without a bet', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    h.bank.balances.set(ALICE.id, 40);

    const calls = await press(message, ALICE, 'same');

    expect(ephemeral(calls)).toEqual([translate('en-US', short(100, 40).userMessage)]);
    expect(textOf(message.latest)).toMatch(/^Seat 1 · \*\*Alice\*\* · 🪙 100 · ⏳ No bet yet$/m);
  });
});

describe('the Change bet modal', () => {
  interface ModalRun {
    readonly button: ResponseCall[];
    readonly modal: ResponseCall[];
    readonly customId: string;
    readonly filter: (submit: unknown) => boolean;
  }

  /** As on Discord, editing the reply to a deferred modal from a button edits the table message. */
  function formOn(
    message: FakeMessage,
    user: FakeUser,
    customId: string,
    amount: string,
  ): ReturnType<typeof fakeModalSubmit> {
    const submit = fakeModalSubmit(customId, { user, fields: { amount } });
    const target = submit.interaction as unknown as {
      editReply: (payload: unknown) => Promise<unknown>;
    };
    const { editReply } = target;
    target.editReply = async (payload) => {
      const result = await editReply(payload);
      message.edits.push(payload);
      return result;
    };
    return submit;
  }

  /** Presses Change bet and submits `amount` in the modal it shows, as Discord would. */
  async function changeBet(
    message: FakeMessage,
    user: FakeUser,
    amount: string,
  ): Promise<ModalRun> {
    const { interaction, calls } = fakeButton(customIdOf(message, 'change'), { message, user });
    let run: Omit<ModalRun, 'button'> = { modal: [], customId: '', filter: () => false };
    Object.assign(interaction, {
      awaitModalSubmit: (options: { filter: (submit: unknown) => boolean }) => {
        const shown = calls.find((call) => call.method === 'showModal')?.options as ModalBuilder;
        const customId = shown.toJSON().custom_id;
        const submit = formOn(message, user, customId, amount);
        run = { modal: submit.calls, customId, filter: options.filter };
        return options.filter(submit.interaction)
          ? Promise.resolve(submit.interaction)
          : Promise.reject(
              new Error('Collector received no interactions before ending with reason: time'),
            );
      },
    });
    collectorOf(message).collect(interaction);
    await flush();
    return { button: calls, ...run };
  }

  /** Presses Change bet; the form is submitted when the test calls `submit`. */
  async function openForm(
    message: FakeMessage,
    user: FakeUser,
  ): Promise<{ readonly submit: (amount: string) => ResponseCall[] }> {
    const { interaction, calls } = fakeButton(customIdOf(message, 'change'), { message, user });
    let submit: (amount: string) => ResponseCall[] = () => [];
    Object.assign(interaction, {
      awaitModalSubmit: () =>
        new Promise((resolve) => {
          submit = (amount) => {
            const shown = calls.find((call) => call.method === 'showModal')
              ?.options as ModalBuilder;
            const form = formOn(message, user, shown.toJSON().custom_id, amount);
            resolve(form.interaction);
            return form.calls;
          };
        }),
    });
    collectorOf(message).collect(interaction);
    await flush();
    return { submit: (amount) => submit(amount) };
  }

  async function afterOneRound(h: Harness): Promise<FakeMessage> {
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    await press(message, ALICE, 'stand');
    return message;
  }

  it('shows a modal filled in with the bet, and places the amount typed in it', async () => {
    const h = setUp();
    const message = await afterOneRound(h);
    stackRound([['10', '9']], ['8', '10']);

    const run = await changeBet(message, ALICE, '250');

    expect(methods(run.button)).toEqual(['showModal']);
    const modal = (run.button[0]?.options as ModalBuilder).toJSON();
    expect(modal.custom_id).toMatch(/^bj:t-1:bet:\d+$/);
    expect(JSON.stringify(modal.components)).toContain('"value":"100"');
    expect(h.context.wallet.openRound.mock.calls.at(-1)?.slice(1)).toEqual([102, 250]);
    expect(methods(run.modal)).toEqual(['deferUpdate', 'editReply']);
    expect(textOf(message.latest)).toMatch(/^▶️ 10♠️ 9♠️ · 19 · 🪙 250$/m);
  });

  it('acknowledges the form before the wallet answers (finding 10)', async () => {
    const h = setUp();
    const message = await afterOneRound(h);
    let release: () => void = () => undefined;
    h.context.wallet.balanceOf.mockImplementationOnce(
      (player) =>
        new Promise((resolve) => {
          release = () => {
            resolve(h.bank.balanceOf(player.userId));
          };
        }),
    );
    stackRound([['10', '9']], ['8', '10']);

    const run = await changeBet(message, ALICE, '250');

    expect(methods(run.modal)).toEqual(['deferUpdate']);
    release();
    await flush();
    expect(methods(run.modal)).toEqual(['deferUpdate', 'editReply']);
    expect(h.context.wallet.openRound.mock.calls.at(-1)?.slice(1)).toEqual([102, 250]);
  });

  it('refuses an amount that does not parse or is below the minimum, and places nothing', async () => {
    const h = setUp();
    const message = await afterOneRound(h);

    const lots = await changeBet(message, ALICE, 'lots');
    const five = await changeBet(message, ALICE, '5');

    expect(ephemeral(lots.modal)).toEqual([
      "That isn't an amount. Try `250`, `2,500`, `1.5k`, `2m`, `all`, `max` or `half`.",
    ]);
    expect(ephemeral(five.modal)).toEqual(['🪙 5 is below the minimum bet of 🪙 10.']);
    expect(h.context.wallet.openRound.mock.calls).toHaveLength(1);
    expect(labels(message)).toEqual(['Same bet (🪙 100)', 'Change bet', 'Leave']);
  });

  it('points a player who already bet this round to /blackjack', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    await press(message, ALICE, 'same');

    const calls = await press(message, ALICE, 'change');

    expect(ephemeral(calls)).toEqual([
      'Your bet of **🪙 100** is placed for this round. Use `/blackjack` to change your bet for the next one.',
    ]);
  });

  it('keeps an amount submitted after betting closed for the next round', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    stackRound([['10', '9']], ['8', '10']);
    const form = await openForm(message, ALICE);
    await press(message, BOB, 'same');
    await vi.advanceTimersByTimeAsync(bettingSeconds * 1000);

    const modal = form.submit('300');
    await flush();

    expect(ephemeral(modal)).toEqual([
      'Betting has closed. Your bet for the next round is **🪙 300**.',
    ]);
    expect(h.context.wallet.openRound.mock.calls.map(([player]) => player.userId)).toEqual([
      ALICE.id,
      BOB.id,
    ]);
    expect(textOf(message.latest)).toMatch(
      /^Seat 1 · \*\*Alice\*\* · 🪙 300 · 💤 Sitting out · 1\/2$/m,
    );
  });

  it('says the bet placed while the form was open stands, and the new amount is for the next round (finding 7)', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    const form = await openForm(message, ALICE);
    await press(message, ALICE, 'same');

    const modal = form.submit('300');
    await flush();

    expect(ephemeral(modal)).toEqual([
      'Your bet of **🪙 100** stands for this round. Your bet for the next round is **🪙 300**.',
    ]);
    expect(
      h.context.wallet.openRound.mock.calls.map(([player, , stake]) => [player.userId, stake]),
    ).toEqual([
      [ALICE.id, 100],
      [ALICE.id, 100],
    ]);
    expect(textOf(message.latest)).toMatch(/^Seat 1 · \*\*Alice\*\* · 🪙 100 · ✅ Bet placed$/m);
    expect(textOf(message.latest)).toMatch(/^\*\*Place your bets!\*\*/m);
  });

  it('only takes the modal this player was shown', async () => {
    const h = setUp();
    const message = await afterOneRound(h);
    stackRound([['10', '9']], ['8', '10']);

    const { filter, customId } = await changeBet(message, ALICE, '200');

    expect(filter(fakeModalSubmit(customId, { user: ALICE }).interaction)).toBe(true);
    expect(filter(fakeModalSubmit(customId, { user: BOB }).interaction)).toBe(false);
    expect(filter(fakeModalSubmit(`${customId}0`, { user: ALICE }).interaction)).toBe(false);
  });

  it('leaves a Change bet form submitted after the wait ran out to interactionCreate', async () => {
    const h = setUp();
    const message = await afterOneRound(h);
    const { interaction, calls } = fakeButton(customIdOf(message, 'change'), {
      message,
      user: ALICE,
    });
    Object.assign(interaction, {
      awaitModalSubmit: () =>
        Promise.reject(
          new Error('Collector received no interactions before ending with reason: time'),
        ),
    });
    collectorOf(message).collect(interaction);
    await flush();
    const shown = calls.find((call) => call.method === 'showModal')?.options as ModalBuilder;
    const customId = shown.toJSON().custom_id;

    expect(h.context.tables.owns(GUILD_ID, customId)).toBe(false);
    expect(h.context.tables.isLive(GUILD_ID, customId)).toBe(true);
    expect(h.context.tables.owns(GUILD_ID, customIdOf(message, 'same'))).toBe(true);
  });
});

describe('insurance (SPEC §7)', () => {
  it('raises the round before taking insurance, and pays it when the dealer has blackjack', async () => {
    const h = setUp();
    stackRound([['10', '9']], ['A', 'K']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    expect(labels(message)).toEqual(['Insurance (🪙 50)', 'No insurance']);

    await press(message, ALICE, 'insure');

    const raised = h.context.wallet.raiseRound.mock;
    const settled = h.context.wallet.settleTableRound.mock;
    expect(raised.calls).toEqual([[1, 50]]);
    expect(settled.calls).toEqual([
      [101, expect.anything(), [expect.objectContaining({ roundId: 1, payout: 150 })]],
    ]);
    expect(raised.invocationCallOrder[0]).toBeLessThan(settled.invocationCallOrder[0] ?? 0);
    expect(textOf(message.latest)).toMatch(/^Insurance paid 🪙 150$/m);
    expect(textOf(message.latest)).toMatch(/^Net 🪙 0 · Balance 🪙 1,000$/m);
    expect(h.bank.balanceOf(ALICE.id)).toBe(1_000);
  });

  it('pays even money to a blackjack while another seat takes insurance', async () => {
    const h = setUp();
    const message = await bothBet(h, () => {
      stackRound(
        [
          ['A', 'K'],
          ['10', '9'],
        ],
        ['A', '7'],
      );
    });
    expect(labels(message)).toEqual([
      'Insurance (🪙 25)',
      'No insurance',
      'Even money',
      'No even money',
    ]);

    const wrong = await press(message, ALICE, 'insure');
    expect(ephemeral(wrong)).toEqual([
      'You have blackjack: answer with **Even money** or **No even money**.',
    ]);
    await press(message, ALICE, 'even');
    await press(message, BOB, 'insure');

    expect(h.context.wallet.raiseRound.mock.calls).toEqual([[3, 25]]);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Bob\*\*'s turn\./m);
    await press(message, BOB, 'stand');

    expect(h.context.wallet.settleTableRound.mock.calls.at(-1)?.[2]).toEqual([
      expect.objectContaining({ roundId: 2, payout: 200 }),
      expect.objectContaining({ roundId: 3, payout: 100 }),
    ]);
    const text = textOf(message.latest);
    expect(text).toMatch(/^A♠️ K♠️ · Blackjack! · 🪙 100 · 💰 Even money$/m);
    expect(text).toMatch(/^Insurance lost \(🪙 25\)$/m);
    expect(text).toMatch(/^Net \+🪙 25 · Balance 🪙 1,025$/m);
  });

  it('gives no insurance to a player who cannot pay for it; time up means no', async () => {
    const h = setUp();
    stackRound([['10', '9']], ['A', '7']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    h.bank.balances.set(ALICE.id, 20);

    const calls = await press(message, ALICE, 'insure');

    expect(ephemeral(calls)).toEqual([translate('en-US', short(50, 20).userMessage)]);
    expect(textOf(message.latest)).toMatch(/^Insurance\? \(🪙 50\)$/m);
    await vi.advanceTimersByTimeAsync(insuranceSeconds * 1000);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Alice\*\*'s turn\./m);
    expect(textOf(message.latest)).not.toMatch(/Insurance/);
    expect(h.bank.balanceOf(ALICE.id)).toBe(20);
  });

  it('tells a seated player who is not in this round to wait', async () => {
    const h = setUp();
    stackRound([['10', '9']], ['A', '7']);
    await sit(h, ALICE, '100');
    await sit(h, BOB, '50');

    const calls = await press(tableMessage(h), BOB, 'insure');

    expect(ephemeral(calls)).toEqual(["You aren't playing this round. Wait for the next one."]);
  });
});

describe('turns (SPEC §7)', () => {
  it('lets only the active player act; anyone else is told whose turn it is', async () => {
    const h = setUp();
    const message = await bothBet(h, () => {
      stackRound(
        [
          ['10', '6'],
          ['10', '7'],
        ],
        ['9', '10'],
        ['5'],
      );
    });
    const edits = message.edits.length;

    const bob = await press(message, BOB, 'hit');

    expect(ephemeral(bob)).toEqual(["It's **Alice**'s turn."]);
    expect(stack).toHaveLength(1);
    expect(message.edits).toHaveLength(edits);

    await press(message, ALICE, 'hit');
    expect(stack).toEqual([]);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Bob\*\*'s turn\./m);
  });

  it('raises once for a double click on Double; the outdated press is acknowledged and ignored', async () => {
    const h = setUp();
    // After a split the second click would land on the player's next hand.
    stackRound([['5', '5']], ['10', '7'], ['6', '10', '6', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    await press(message, ALICE, 'split');
    const double = customIdOf(message, 'double');

    const first = pressOnce(message, ALICE, double);
    const second = pressOnce(message, ALICE, double);
    await flush();

    expect(h.context.wallet.raiseRound.mock.calls).toEqual([
      [1, 100],
      [1, 100],
    ]);
    expect(methods(first)).toEqual(['update']);
    expect(second).toEqual([{ method: 'deferUpdate', options: undefined }]);
    expect(stack).toEqual([{ rank: '10', suit: 'spades' }]);
    expect(textOf(message.latest)).toMatch(
      /^5♠️ 6♠️ 10♠️ · 21 · 🪙 200, doubled\n▶️ 5♠️ 6♠️ · 11 · 🪙 100$/m,
    );
  });

  it('deals one card for a double click on Hit', async () => {
    const h = setUp();
    stackRound([['10', '2']], ['10', '7'], ['3', '4']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    const hit = customIdOf(message, 'hit');

    pressOnce(message, ALICE, hit);
    const second = pressOnce(message, ALICE, hit);
    await flush();

    expect(second).toEqual([{ method: 'deferUpdate', options: undefined }]);
    expect(stack).toEqual([{ rank: '4', suit: 'spades' }]);
    expect(textOf(message.latest)).toMatch(/^▶️ 10♠️ 2♠️ 3♠️ · 15 · 🪙 100$/m);
  });

  it('refuses a double the player cannot afford with an ephemeral error, and changes nothing', async () => {
    const h = setUp();
    stackRound([['6', '5']], ['10', '7'], ['10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    h.bank.balances.set(ALICE.id, 50);

    const calls = await press(message, ALICE, 'double');

    expect(methods(calls)).toEqual(['update', 'followUp']);
    expect(ephemeral(calls)).toEqual([translate('en-US', short(100, 50).userMessage)]);
    expect(stack).toHaveLength(1);
    expect(textOf(message.latest)).toMatch(/^▶️ 6♠️ 5♠️ · 11 · 🪙 100$/m);
    expect(buttonsOf(message.latest).map((button) => [button.label, button.disabled])).toEqual([
      ['Hit', false],
      ['Stand', false],
      ['Double (🪙 100)', true],
      ['Split (🪙 100)', true],
      ['Surrender', false],
    ]);

    await press(message, ALICE, 'stand');
    expect(h.context.wallet.settleTableRound.mock.calls.at(-1)?.[2]).toEqual([
      expect.objectContaining({ roundId: 1, payout: 0 }),
    ]);
  });

  it('stands every remaining hand when the turn times out, and says so', async () => {
    const h = setUp();
    stackRound([['8', '8']], ['10', '7'], ['3', '2']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    await press(message, ALICE, 'split');
    expect(textOf(message.latest)).toMatch(/^▶️ 8♠️ 3♠️ · 11 · 🪙 100$/m);

    await vi.advanceTimersByTimeAsync(turnSeconds * 1000 - 1);
    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    const text = textOf(message.latest);
    expect(text).toMatch(/^8♠️ 3♠️ · 11 · 🪙 100 · ❌ Lose\n8♠️ 2♠️ · 10 · 🪙 100 · ❌ Lose$/m);
    expect(text).toMatch(/^⏱️ Out of time: the bot stood automatically\.$/m);
    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([
      [101, expect.anything(), [expect.objectContaining({ roundId: 1, payout: 0 })]],
    ]);
  });

  it('gives the next player a fresh turn after a timeout', async () => {
    const h = setUp();
    const message = await bothBet(h, () => {
      stackRound(
        [
          ['10', '6'],
          ['10', '7'],
        ],
        ['9', '10'],
      );
    });
    await vi.advanceTimersByTimeAsync(turnSeconds * 1000);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Bob\*\*'s turn\./m);

    await vi.advanceTimersByTimeAsync(turnSeconds * 1000 - 1);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Bob\*\*'s turn\./m);
    await vi.advanceTimersByTimeAsync(1);
    expect(textOf(message.latest)).toMatch(/^\*\*Place your bets!\*\*/m);
  });
});

describe('settlement (SPEC §4 settle, then show)', () => {
  it("settles every seat once, with the engine's payouts, before the result is shown", async () => {
    const h = setUp();
    const message = await bothBet(h, () => {
      stackRound(
        [
          ['10', '9'],
          ['10', '6'],
        ],
        ['7', '10'],
      );
    });
    const settled = h.context.wallet.settleTableRound.mock;
    let release: () => void = () => undefined;
    h.context.wallet.settleTableRound.mockImplementationOnce(
      (_tableRoundId, _outcome, settlements) =>
        new Promise((resolve) => {
          release = () => {
            resolve(h.bank.settle(settlements));
          };
        }),
    );
    await press(message, ALICE, 'stand');

    const stand = await press(message, BOB, 'stand');
    expect(settled.calls).toHaveLength(2);
    expect(settled.calls.at(-1)).toEqual([
      102,
      expect.objectContaining({ dealer: expect.objectContaining({ total: 17 }) as unknown }),
      [
        {
          roundId: 2,
          payout: 200,
          details: expect.objectContaining({ id: ALICE.id, staked: 100 }) as unknown,
        },
        {
          roundId: 3,
          payout: 0,
          details: expect.objectContaining({ id: BOB.id, staked: 50 }) as unknown,
        },
      ],
    ]);
    expect(stand).toEqual([]);
    expect(textOf(message.latest)).toMatch(/^7♠️ 🎴$/m);

    release();
    await flush();
    expect(methods(stand)).toEqual(['update']);
    const text = textOf(message.latest);
    expect(text).toMatch(/^Dealer · last round\n7♠️ 10♠️ · 17$/m);
    expect(text).toMatch(/^10♠️ 6♠️ · 16 · 🪙 50 · ❌ Lose\nNet -🪙 50 · Balance 🪙 950$/m);
    expect(settled.calls).toHaveLength(2);
  });

  it('refunds the table round when the settlement fails, says so, and ends the game', async () => {
    const { logger, lines } = captureLogs();
    const h = setUp(fakeContext({ logger }));
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    h.context.wallet.settleTableRound.mockRejectedValueOnce(new Error('connection lost'));
    const table = tableOf(h, ALICE);

    const message = tableMessage(h);
    await press(message, ALICE, 'stand');

    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[101]]);
    expect(h.bank.balanceOf(ALICE.id)).toBe(1_000);
    expect(textOf(message.latest)).toMatch(
      /^⚠️ This round could not be settled, so every stake was refunded and this game has ended\.$/m,
    );
    expect(textOf(message.latest)).not.toMatch(/10♠️/);
    expect(buttonsOf(message.latest)).toEqual([]);
    expect(tableOf(h, ALICE)).toBeUndefined();
    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'over' }]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: 'could not settle a blackjack round',
        tableRoundId: 101,
      }),
    );
  });

  it('says the stakes come back shortly when the refund fails too, and the retry lets the player play again (R3)', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    h.context.wallet.settleTableRound.mockRejectedValueOnce(new Error('connection lost'));
    h.context.wallet.refundTableRound.mockRejectedValueOnce(new Error('connection lost'));
    const table = tableOf(h, ALICE);

    const message = tableMessage(h);
    await press(message, ALICE, 'stand');

    expect(textOf(message.latest)).toMatch(
      /^⚠️ This round could not be settled, so this game has ended\. Its stakes come back to you automatically shortly\.$/m,
    );
    expect(textOf(message.latest)).not.toMatch(/restart/);
    expect(buttonsOf(message.latest)).toEqual([]);
    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'over' }]);
    expect(h.bank.balanceOf(ALICE.id)).toBe(900);
    // Her round is still open, so the database refuses another until the refund goes through.
    stackRound([['10', '9']], ['8', '10']);
    const early = await sit(h, ALICE, '100');
    expect(ephemeral(early)).toEqual([translate('en-US', ['errors.generic'])]);
    expect(h.channel.threadsStarted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.context.wallet.refundTableRound.mock.calls[2]).toEqual([101]);
    expect(h.bank.balanceOf(ALICE.id)).toBe(1_000);

    const again = await sit(h, ALICE, '100');
    expect(contentOf(again.at(-1)?.options)).toMatch(
      /^You have seat 1, with a bet of \*\*🪙 100\*\* on this round\. /,
    );
    expect(h.channel.threadsStarted).toHaveLength(2);
    expect(h.bank.balanceOf(ALICE.id)).toBe(900);
  });

  it('says the round went through when the refund finds it settled after all (finding 8)', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    h.context.wallet.settleTableRound.mockRejectedValueOnce(new Error('the answer got lost'));
    h.context.wallet.refundTableRound.mockRejectedValueOnce(
      new TableRoundClosedError(101, 'settled'),
    );
    const table = tableOf(h, ALICE);

    const message = tableMessage(h);
    await press(message, ALICE, 'stand');

    expect(textOf(message.latest)).toMatch(
      /^⚠️ This round went through, but its result can't be shown, so this game has ended\. Check your coins with `\/balance`\.$/m,
    );
    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'over' }]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[101]]);
  });
});

describe('the shoe (SPEC §7)', () => {
  it('draws with crypto.randomInt, one shoe per table, reshuffled before a round once due', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    await press(message, ALICE, 'stand');
    const [shoe] = shoes;
    expect(shoes).toHaveLength(1);
    expect(shoe?.draw).toBe(randomInt);
    expect(shoe?.shuffles).toBe(0);
    if (shoe !== undefined) shoe.reshuffleDue = true;
    stackRound([['10', '9']], ['8', '10']);

    await press(message, ALICE, 'same');

    expect(shoe?.shuffles).toBe(1);
    expect(shoes).toHaveLength(1);
    expect(textOf(message.latest)).toMatch(/^It's \*\*Alice\*\*'s turn\./m);
  });
});

describe('closing', () => {
  it('stops the timers and the collector at shutdown, and settles nothing', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    const table = tableOf(h, ALICE);

    await table?.close();

    expect(textOf(message.latest)).toMatch(
      /^This table closed for a restart\. Open stakes are refunded/m,
    );
    expect(buttonsOf(message.latest)).toEqual([]);
    expect(collectorOf(message).ended).toBe(true);
    const edits = message.edits.length;
    await vi.advanceTimersByTimeAsync(10 * turnSeconds * 1000);
    expect(message.edits).toHaveLength(edits);
    expect(h.context.wallet.settleTableRound.mock.calls).toEqual([]);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([]);
    expect(hostOf(h).ends).toEqual([]);
  });

  it('refunds the open round, frees the seats and closes the table when its thread is deleted', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    const table = tableOf(h, ALICE);

    collectorOf(message).stop('threadDelete');
    await flush();

    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[101]]);
    expect(h.bank.balanceOf(ALICE.id)).toBe(1_000);
    expect(tableOf(h, ALICE)).toBeUndefined();
    expect(h.context.tables.all()).toEqual([]);
    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'lost' }]);
    const edits = message.edits.length;
    await vi.advanceTimersByTimeAsync(10 * turnSeconds * 1000);
    expect(message.edits).toHaveLength(edits);
  });

  it('closes a table whose message is gone at its next edit, refunds it and seats nobody there (finding 1)', async () => {
    const h = setUp();
    const message = await aliceThenBob(h);
    stackRound([['10', '9']], ['8', '10']);
    await press(message, ALICE, 'same');
    const table = tableOf(h, ALICE);
    const edit = vi.spyOn(message, 'edit');
    message.editError = discordError(10008);

    // Bob sits out, so the timer deals Alice's hand and then fails to show it.
    await vi.advanceTimersByTimeAsync(bettingSeconds * 1000);

    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([[102]]);
    expect(h.bank.balanceOf(ALICE.id)).toBe(1_100);
    expect(h.context.tables.all()).toEqual([]);
    expect([tableOf(h, ALICE), tableOf(h, BOB)]).toEqual([undefined, undefined]);
    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'lost' }]);
    expect(hostOf(h).closed).toBe(true);
    const attempts = edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * turnSeconds * 1000);
    expect(edit.mock.calls).toHaveLength(attempts);

    stackRound([['9', '8']], ['6', '10']);
    await sit(h, BOB, '50');
    expect(h.channel.threadsStarted).toHaveLength(2);
    expect(tableOf(h, BOB)).not.toBe(table);
    expect(hostOf(h, 1).begun).toEqual([tableOf(h, BOB)]);
  });

  it('leaves other edit errors alone', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    message.editError = discordError(50035, 400);

    await sit(h, BOB, '50');

    expect(tableOf(h, ALICE)).toBeDefined();
    expect(tableOf(h, BOB)).toBe(tableOf(h, ALICE));
    expect(hostOf(h).ends).toEqual([]);
    expect(h.context.wallet.refundTableRound.mock.calls).toEqual([]);
  });
});

describe('shutdown (R1)', () => {
  it('opens no table and debits nothing for a /blackjack that runs into closeAll', async () => {
    const h = setUp();
    stackRound([['10', '8']], ['7', '10']);
    await sit(h, ALICE, '100');
    const message = tableMessage(h);
    let lose: () => void = () => undefined;
    vi.spyOn(message, 'edit').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          lose = () => {
            reject(discordError(10008));
          };
        }),
    );
    // Alice's turn times out; the table's edit hangs, and Cy's seat waits behind it.
    await vi.advanceTimersByTimeAsync(turnSeconds * 1000);
    const cy = startSit(h, CY, '50');
    await flush();

    const table = tableOf(h, ALICE);
    const closing = h.context.tables.closeAll();
    lose();
    await cy.done;
    await closing;

    // The lost edit closed the table under Cy's waiting seat, so his seating went on to a new table.
    expect(hostOf(h).ends).toEqual([{ game: table, reason: 'lost' }]);
    expect(ephemeral(cy.calls)).toEqual([translate('en-US', ['errors.restarting'])]);
    expect(h.context.wallet.openRound.mock.calls.map(([player]) => player.userId)).toEqual([
      ALICE.id,
    ]);
    expect(h.channel.threadsStarted).toHaveLength(1);
    expect(h.context.tables.all()).toEqual([]);
  });

  it('opens no table and debits nothing after closeAll', async () => {
    const h = setUp();
    await h.context.tables.closeAll();

    const calls = await sit(h, ALICE, '100');

    expect(ephemeral(calls)).toEqual([translate('en-US', ['errors.restarting'])]);
    expect(h.context.wallet.openTableRound.mock.calls).toEqual([]);
    expect(h.context.wallet.openRound.mock.calls).toEqual([]);
    expect(h.channel.threadsStarted).toEqual([]);
  });
});
