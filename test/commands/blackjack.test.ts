import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  Collection,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { respondWithBetChoices } from '../../src/bot/bet-autocomplete.js';
import { playBlackjack } from '../../src/bot/tables/blackjack-table.js';
import type { TableParent } from '../../src/bot/tables/thread.js';
import type { Command } from '../../src/bot/types.js';
import blackjack from '../../src/commands/games/blackjack.js';
import { PlayerError } from '../../src/core/errors.js';
import interactionCreate from '../../src/events/interaction-create.js';
import type { Card, Rank } from '../../src/games/blackjack/index.js';
import { fakeContext, type FakeContext } from '../helpers/context.js';
import {
  CHANNEL_ID,
  contentOf,
  FakeChannel,
  fakeChatInput,
  fakeModalSubmit,
  fakeUser,
  GUILD_ID,
  isEphemeral,
  type FakeUser,
  type ResponseCall,
} from '../helpers/discord.js';

const { stack } = vi.hoisted(() => ({ stack: [] as Card[] }));

vi.mock('../../src/games/blackjack/index.js', async (importOriginal) => {
  const engine = await importOriginal<typeof import('../../src/games/blackjack/index.js')>();
  class StackedShoe {
    readonly reshuffleDue = false;

    get cardsLeft(): number {
      return stack.length;
    }

    shuffle(): void {
      throw new Error('a stacked shoe is never due');
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
const BALANCE = 1_000;
const commands = new Collection<string, Command>([['blackjack', blackjack]]);

/** One player's round: their cards around the dealer's upcard, then the hole card. */
function stackSoloRound(player: readonly [Rank, Rank] = ['10', '8']): void {
  const ranks: Rank[] = [player[0], '7', player[1], '10'];
  stack.push(...ranks.map((rank): Card => ({ rank, suit: 'spades' })));
}

function seatingContext(): FakeContext {
  const context = fakeContext();
  context.wallet.balanceOf.mockResolvedValue(BALANCE);
  context.wallet.openTableRound.mockResolvedValue(101);
  let rounds = 0;
  context.wallet.openRound.mockImplementation((_player, _tableRoundId, stake) => {
    rounds += 1;
    return Promise.resolve({ roundId: rounds, stake, balance: BALANCE - stake });
  });
  return context;
}

async function run(
  context: FakeContext,
  user: FakeUser,
  bet: string,
  channel: FakeChannel,
  appPermissions?: bigint,
): Promise<ResponseCall[]> {
  const { interaction, calls } = fakeChatInput('blackjack', {
    user,
    channel,
    commands,
    appPermissions,
    strings: { bet },
  });
  await interactionCreate.execute(context, interaction);
  await vi.advanceTimersByTimeAsync(0);
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  stack.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/blackjack data (SPEC §3)', () => {
  const json = blackjack.data.toJSON();

  it('is a server-only slash command with a required bet option that autocompletes', () => {
    expect(json.name).toBe('blackjack');
    expect(json.description).toMatch(/^.{1,100}$/su);
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
    expect(json.options).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.String,
        name: 'bet',
        required: true,
        autocomplete: true,
        description: expect.stringMatching(/^.{1,100}$/su) as unknown,
      }),
    ]);
  });

  it('answers autocomplete with the shared bet choices and keeps the default cooldown', () => {
    expect(blackjack.autocomplete).toBe(respondWithBetChoices);
    expect('cooldown' in blackjack).toBe(false);
  });
});

const DEFERRED = { method: 'deferReply', options: { flags: MessageFlags.Ephemeral } };

function ephemeralFollowUp(content: string): ResponseCall {
  return { method: 'followUp', options: { content, flags: MessageFlags.Ephemeral } };
}

describe('/blackjack seating (SPEC §4 and §7)', () => {
  it('opens a table thread, posts nothing in the channel, and confirms the seat ephemerally with a link', async () => {
    const context = seatingContext();
    const channel = new FakeChannel();
    stackSoloRound();

    const calls = await run(context, ALICE, '100', channel);

    expect(channel.messages).toEqual([]);
    expect(channel.threadsStarted.map((thread) => thread.name)).toEqual(['Table #1 (Blackjack)']);
    const [table] = channel.allMessages;
    expect(context.tables.tableOf('blackjack', GUILD_ID, ALICE.id)?.channelId).toBe(CHANNEL_ID);
    expect(calls.map((call) => [call.method, isEphemeral(call.options)])).toEqual([
      ['deferReply', true],
      ['editReply', false],
    ]);
    expect(contentOf(calls[1]?.options)).toBe(
      `You have seat 1, with a bet of **🪙 100** on this round. [Go to the table](${table?.url ?? ''})`,
    );
  });

  it('seats a player at a table with room in another channel, and says it is elsewhere', async () => {
    const context = seatingContext();
    const here = new FakeChannel();
    const elsewhere = new FakeChannel('300000000000000002');
    stackSoloRound();
    await run(context, ALICE, '100', here);

    const calls = await run(context, BOB, '50', elsewhere);

    expect(elsewhere.allMessages).toEqual([]);
    expect(context.tables.tableOf('blackjack', GUILD_ID, BOB.id)).toBe(
      context.tables.tableOf('blackjack', GUILD_ID, ALICE.id),
    );
    expect(contentOf(calls.at(-1)?.options)).toBe(
      `You have seat 2. Your bet for the next round is **🪙 50**: press **Same bet** when betting opens. This table is in another channel: [go to the table](${here.allMessages[0]?.url ?? ''}).`,
    );
  });

  it('seats two players who sit down at the same moment at one table', async () => {
    const context = seatingContext();
    const channel = new FakeChannel();
    stackSoloRound();

    await Promise.all([run(context, ALICE, '100', channel), run(context, BOB, '50', channel)]);

    expect(channel.threadsStarted).toHaveLength(1);
    expect(context.tables.all()).toHaveLength(1);
  });

  it('names every permission it misses instead of opening a table', async () => {
    const context = seatingContext();
    const channel = new FakeChannel();

    const calls = await run(context, ALICE, '100', channel, PermissionFlagsBits.ViewChannel);

    expect(channel.threadsStarted).toEqual([]);
    expect(context.tables.all()).toEqual([]);
    expect(context.wallet.openRound.mock.calls).toEqual([]);
    expect(calls).toEqual([
      DEFERRED,
      ephemeralFollowUp(
        "I can't open a table in this channel. I'm missing: Create Public Threads, Send Messages in Threads, Embed Links.",
      ),
    ]);
  });

  it('refuses a bet that is not an amount or is below the minimum, before seating anyone', async () => {
    const context = seatingContext();
    const channel = new FakeChannel();

    const lots = await run(context, ALICE, 'lots', channel);
    const five = await run(context, ALICE, '5', channel);

    expect([...lots, ...five]).toEqual([
      DEFERRED,
      ephemeralFollowUp(
        "That isn't an amount. Try `250`, `2,500`, `1.5k`, `2m`, `all`, `max` or `half`.",
      ),
      DEFERRED,
      ephemeralFollowUp('🪙 5 is below the minimum bet of 🪙 10.'),
    ]);
    expect(context.tables.all()).toEqual([]);
  });

  it('refuses a bet above the balance before taking a seat', async () => {
    const context = seatingContext();
    const channel = new FakeChannel();

    const calls = await run(context, ALICE, '2k', channel);

    expect(calls).toEqual([
      DEFERRED,
      ephemeralFollowUp(
        "You don't have enough coins: this needs 🪙 2,000, and your balance is 🪙 1,000.",
      ),
    ]);
    expect(channel.threadsStarted).toEqual([]);
    expect(context.tables.all()).toEqual([]);
  });

  it('defers before the first database call, also when that call fails (finding 10)', async () => {
    const context = seatingContext();
    context.wallet.balanceOf.mockRejectedValue(new Error('connection lost'));

    const calls = await run(context, ALICE, '100', new FakeChannel());

    expect(calls).toEqual([
      DEFERRED,
      ephemeralFollowUp('Something went wrong on our side. Please try again in a moment.'),
    ]);
    expect(context.wallet.balanceOf.mock.calls).toHaveLength(1);
  });
});

describe('the lobby bet form (SPEC §4)', () => {
  it('plays exactly like /blackjack typed in the thread', async () => {
    const context = seatingContext();
    const channel = new FakeChannel();
    await context.hosts.open({
      context,
      parent: channel as unknown as TableParent,
      game: null,
      locale: 'en-US',
      userId: ALICE.id,
    });
    const [host] = context.hosts.opened;
    if (host === undefined) throw new Error('the lobby did not open');
    stackSoloRound();
    const form = fakeModalSubmit(`tb:${host.id}:form:blackjack`, {
      user: ALICE,
      channel: host.thread,
      fields: { amount: '100' },
    });

    await playBlackjack(form.interaction, '100', context);

    const table = context.tables.tableOf('blackjack', GUILD_ID, ALICE.id);
    expect(host.begun).toEqual([table]);
    expect(channel.threadsStarted).toEqual([host.thread]);
    expect(context.wallet.openRound.mock.calls).toEqual([
      [{ guildId: GUILD_ID, userId: ALICE.id, displayName: 'Alice' }, 101, 100],
    ]);
    expect(form.calls).toEqual([
      DEFERRED,
      {
        method: 'editReply',
        options: {
          content: `You have seat 1, with a bet of **🪙 100** on this round. [Go to the table](${host.thread.messages[0]?.url ?? ''})`,
        },
      },
    ]);
  });

  it('throws a player error to the form, which shows it', async () => {
    const context = seatingContext();
    const form = fakeModalSubmit('tb:h1:form:blackjack', {
      user: ALICE,
      channel: new FakeChannel(),
      fields: { amount: 'lots' },
    });

    await expect(playBlackjack(form.interaction, 'lots', context)).rejects.toBeInstanceOf(
      PlayerError,
    );
    expect(form.calls).toEqual([DEFERRED]);
  });
});
