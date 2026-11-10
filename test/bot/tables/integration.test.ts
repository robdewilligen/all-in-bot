import {
  ChannelType,
  type ActionRowBuilder,
  type ButtonBuilder,
  type ModalBuilder,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableHosts } from '../../../src/bot/tables/table.js';
import type { AppContext } from '../../../src/bot/types.js';
import blackjack from '../../../src/commands/games/blackjack.js';
import createTable from '../../../src/commands/games/create-table.js';
import roulette from '../../../src/commands/games/roulette.js';
import { gameConfig } from '../../../src/config/game.js';
import type { SettledRound } from '../../../src/core/wallet.js';
import { fakeContext, type FakeContext } from '../../helpers/context.js';
import {
  FakeChannel,
  fakeButton,
  fakeChatInput,
  fakeModalSubmit,
  fakeUser,
  textOf,
  type FakeMessage,
  type FakeThread,
  type FakeUser,
  type ResponseCall,
} from '../../helpers/discord.js';

/**
 * The real TableHost with the real roulette and blackjack games, no mocks in between: one table
 * through its whole life (SPEC §4). The units each have their own specs; this proves they fit.
 */

const ALICE = fakeUser('200000000000000001', 'alice', 'Alice');
const BOB = fakeUser('200000000000000002', 'bob', 'Bob');
const BALANCE = 10_000;

interface Harness {
  readonly context: FakeContext & AppContext;
  readonly channel: FakeChannel;
}

function setUp(): Harness {
  let tables = 0;
  const base = fakeContext();
  const context = { ...base, hosts: createTableHosts({ next: () => Promise.resolve(++tables) }) };
  const { wallet } = context;
  const rounds = new Map<number, { userId: string; stake: number }>();
  let tableRound = 1;
  wallet.balanceOf.mockResolvedValue(BALANCE);
  wallet.openTableRound.mockImplementation(() => Promise.resolve(tableRound++));
  wallet.openRound.mockImplementation((who, _tableRoundId, stake) => {
    const roundId = 100 + rounds.size;
    rounds.set(roundId, { userId: who.userId, stake });
    return Promise.resolve({ roundId, stake, balance: BALANCE - stake });
  });
  wallet.raiseRound.mockImplementation((roundId, amount) => {
    const round = rounds.get(roundId);
    if (round === undefined) return Promise.reject(new Error(`no round ${String(roundId)}`));
    round.stake += amount;
    return Promise.resolve({ roundId, stake: round.stake, balance: BALANCE - round.stake });
  });
  wallet.settleTableRound.mockImplementation((_tableRoundId, _outcome, settlements) =>
    Promise.resolve(
      settlements.map(({ roundId, payout }): SettledRound => {
        const round = rounds.get(roundId) ?? { userId: 'nobody', stake: 0 };
        return {
          roundId,
          userId: round.userId,
          stake: round.stake,
          payout,
          balance: BALANCE - round.stake + payout,
        };
      }),
    ),
  );
  return { context: context as FakeContext & AppContext, channel: new FakeChannel('casino') };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function buttonIds(message: FakeMessage): string[] {
  const { components = [] } = message.latest as {
    components?: readonly ActionRowBuilder<ButtonBuilder>[];
  };
  return components.flatMap((row) =>
    row.toJSON().components.flatMap((part) => ('custom_id' in part ? [part.custom_id] : [])),
  );
}

function lobbyButton(message: FakeMessage, action: string): string {
  const id = buttonIds(message).find((customId) => customId.split(':')[2] === action);
  if (id === undefined) throw new Error(`the lobby has no ${action} button`);
  return id;
}

/** Presses a lobby button in the thread; a game button's form is submitted with `text`. */
async function pressLobby(
  thread: FakeThread,
  lobby: FakeMessage,
  user: FakeUser,
  action: string,
  text = '',
): Promise<{ button: ResponseCall[]; form: ResponseCall[] }> {
  const { interaction, calls } = fakeButton(lobbyButton(lobby, action), {
    message: lobby,
    user,
    channel: thread,
  });
  let form: ResponseCall[] = [];
  Object.assign(interaction, {
    awaitModalSubmit: (options: { filter: (candidate: unknown) => boolean }) => {
      const shown = calls.find((call) => call.method === 'showModal')?.options as ModalBuilder;
      const field = action === 'roulette' ? 'bets' : 'bet';
      const submitted = fakeModalSubmit(shown.toJSON().custom_id, {
        user,
        channel: thread,
        fields: { [field]: text },
      });
      form = submitted.calls;
      if (!options.filter(submitted.interaction)) throw new Error('the filter refused the form');
      return Promise.resolve(submitted.interaction);
    },
  });
  const collector = lobby.collectors.at(-1);
  if (collector === undefined) throw new Error('the lobby has no collector');
  collector.collect(interaction);
  await flush();
  return { button: calls, form };
}

describe('a table thread from /create-table to its archive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays roulette from the lobby, then blackjack, then closes when everyone left', async () => {
    const h = setUp();

    const created = fakeChatInput('create-table', { user: ALICE, channel: h.channel });
    await createTable.execute(created.interaction, h.context);
    await flush();

    const thread = h.channel.threadsStarted[0];
    if (thread === undefined) throw new Error('/create-table started no thread');
    expect(thread.type).toBe(ChannelType.PublicThread);
    expect(thread.name).toBe('Table #1');
    expect(h.channel.messages).toEqual([]);
    const firstLobby = thread.messages[0];
    if (firstLobby === undefined) throw new Error('no lobby');
    expect(buttonIds(firstLobby).map((id) => id.split(':')[2])).toEqual([
      'roulette',
      'blackjack',
      'leave',
    ]);

    // Bob picks Roulette in the lobby and bets through the form.
    const form = await pressLobby(thread, firstLobby, BOB, 'roulette', '10:red');
    expect(form.button.map((call) => call.method)).toEqual(['showModal']);
    expect(form.form[0]?.method).toBe('deferReply');
    expect(h.context.wallet.openRound.mock.calls.map(([who]) => who.userId)).toEqual([BOB.id]);
    expect(thread.name).toBe('Table #1 (Roulette)');
    expect(buttonIds(firstLobby)).toEqual([]);
    const spin = thread.messages[1];
    expect(spin).toBeDefined();
    expect(h.channel.messages).toEqual([]);

    // The spin settles, the result shows, and the table is back in its lobby.
    await vi.advanceTimersByTimeAsync(
      gameConfig.roulette.bettingSeconds * 1000 + gameConfig.roulette.revealDelayMs + 1_000,
    );
    expect(h.context.wallet.settleTableRound.mock.calls).toHaveLength(1);
    const secondLobby = thread.messages[2];
    if (secondLobby === undefined) throw new Error('no lobby after the spin');
    expect(buttonIds(secondLobby).map((id) => id.split(':')[2])).toEqual([
      'roulette',
      'blackjack',
      'leave',
    ]);

    // /blackjack typed in the thread starts blackjack at this table.
    const seat = fakeChatInput('blackjack', {
      user: BOB,
      channel: thread,
      strings: { bet: '100' },
    });
    await blackjack.execute(seat.interaction, h.context);
    await flush();
    expect(thread.name).toBe('Table #1 (Blackjack)');
    expect(thread.renames).toEqual(['Table #1 (Roulette)', 'Table #1 (Blackjack)']);
    expect(buttonIds(secondLobby)).toEqual([]);
    expect(h.channel.threadsStarted).toHaveLength(1);
    expect(textOf(thread.messages[3]?.latest)).toMatch(/Table #1/);

    // Bob plays one round and then sits out twice, which ends the game: a new lobby appears.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const thirdLobby = thread.messages.at(-1);
    if (thirdLobby === undefined) throw new Error('no lobby after blackjack');
    expect(thirdLobby).not.toBe(thread.messages[3]);
    expect(buttonIds(thirdLobby)).toContain(lobbyButton(thirdLobby, 'leave'));
    expect(thread.archived).toBe(false);

    // Both players leave; the table closes and its thread is archived.
    await pressLobby(thread, thirdLobby, ALICE, 'leave');
    expect(thread.archived).toBe(false);
    await pressLobby(thread, thirdLobby, BOB, 'leave');
    expect(thread.archived).toBe(true);
    expect(buttonIds(thirdLobby)).toEqual([]);
    expect(h.context.tables.hostIn(h.channel.guildId, thread.id)).toBeUndefined();
    expect(h.context.tables.all()).toEqual([]);
  });

  it('opens Table #2 (Roulette) for /roulette in the channel when no table has room', async () => {
    const h = setUp();
    await createTable.execute(
      fakeChatInput('create-table', { user: ALICE, channel: h.channel }).interaction,
      h.context,
    );

    const bets = fakeChatInput('roulette', {
      user: BOB,
      channel: h.channel,
      strings: { bets: '10:black' },
    });
    await roulette.execute(bets.interaction, h.context);
    await flush();

    expect(h.channel.threadsStarted.map((thread) => thread.name)).toEqual([
      'Table #1',
      'Table #2 (Roulette)',
    ]);
    expect(h.channel.messages).toEqual([]);
    expect(h.channel.threadsStarted[1]?.messages).toHaveLength(1);
  });
});
