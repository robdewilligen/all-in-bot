import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableHosts } from '../../src/bot/tables/table.js';
import type { AppContext, Command } from '../../src/bot/types.js';
import createTable from '../../src/commands/games/create-table.js';
import { gameConfig } from '../../src/config/game.js';
import interactionCreate from '../../src/events/interaction-create.js';
import { captureLogs, fakeContext, type LogCapture } from '../helpers/context.js';
import {
  contentOf,
  FakeChannel,
  fakeChatInput,
  GUILD_ID,
  isEphemeral,
  TABLE_PERMISSIONS,
  textOf,
  type ChatInputOptions,
  type ResponseCall,
} from '../helpers/discord.js';

// Bet forms are not part of these tests; the real game modules stay out of them.
vi.mock('../../src/bot/tables/roulette-table.js', () => ({ playRoulette: vi.fn() }));
vi.mock('../../src/bot/tables/blackjack-table.js', () => ({ playBlackjack: vi.fn() }));

const commands = new Collection<string, Command>([['create-table', createTable]]);

/** The chat of a voice channel: a text channel without threads. */
class FakeVoiceChat extends FakeChannel {
  override readonly type: ChannelType = ChannelType.GuildVoice;
}

interface Harness {
  readonly context: AppContext;
  readonly channel: FakeChannel;
  readonly next: ReturnType<typeof vi.fn<(guildId: string) => Promise<number>>>;
  readonly logs: LogCapture;
}

function setUp(channel: FakeChannel = new FakeChannel()): Harness {
  let count = 0;
  const next = vi.fn<(guildId: string) => Promise<number>>(() => Promise.resolve((count += 1)));
  const logs = captureLogs();
  const context: AppContext = {
    ...fakeContext({ logger: logs.logger }),
    hosts: createTableHosts({ next }),
  };
  return { context, channel, next, logs };
}

async function run(
  h: Harness,
  options: ChatInputOptions = {},
  change?: (interaction: object) => void,
): Promise<ResponseCall[]> {
  const { interaction, calls } = fakeChatInput('create-table', {
    channel: h.channel,
    commands,
    ...options,
  });
  change?.(interaction);
  await interactionCreate.execute(h.context, interaction);
  await vi.advanceTimersByTimeAsync(0);
  return calls;
}

const methods = (calls: readonly ResponseCall[]): string[] => calls.map((call) => call.method);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/create-table', () => {
  it('has no options, and its own cooldown', () => {
    expect(createTable.data.toJSON()).toMatchObject({ name: 'create-table', options: [] });
    expect(createTable.cooldown).toBe(gameConfig.cooldowns.createTableSeconds);
  });

  it('starts a thread "Table #N" with a lobby, posts nothing in the channel and links to it', async () => {
    const h = setUp();

    const calls = await run(h);

    expect(methods(calls)).toEqual(['deferReply', 'editReply']);
    expect(isEphemeral(calls[0]?.options)).toBe(true);
    expect(h.channel.messages).toEqual([]);
    const [thread] = h.channel.threadsStarted;
    expect(thread?.name).toBe('Table #1');
    expect(textOf(thread?.messages[0]?.latest)).toMatch(/^Table #1 · pick a game$/m);
    expect(contentOf(calls[1]?.options)).toBe(
      `Your table is open: [Table #1](${thread?.url ?? ''}). Pick a game there.`,
    );
    expect(h.next.mock.calls).toEqual([[GUILD_ID]]);
    expect(h.context.tables.hostIn(GUILD_ID, thread?.id ?? '')).toBeDefined();
  });

  it('inside a thread, opens the new table in the channel the thread is in', async () => {
    const h = setUp();
    const other = await h.channel.threads.create({ name: 'chat' });

    await run(h, { channel: other });

    expect(h.channel.threadsStarted.map((thread) => thread.name)).toEqual(['chat', 'Table #1']);
    expect(other.threadsStarted).toEqual([]);
  });

  it('names a missing permission privately, and starts no thread', async () => {
    const h = setUp();

    const calls = await run(h, {
      appPermissions: TABLE_PERMISSIONS & ~PermissionFlagsBits.CreatePublicThreads,
    });

    expect(methods(calls)).toEqual(['deferReply', 'followUp']);
    expect(isEphemeral(calls[1]?.options)).toBe(true);
    expect(contentOf(calls[1]?.options)).toBe(
      "I can't open a table in this channel. I'm missing: Create Public Threads.",
    );
    expect(h.channel.threadsStarted).toEqual([]);
    expect(h.next).not.toHaveBeenCalled();
  });

  it('refuses privately in a channel without threads, and starts no thread', async () => {
    const h = setUp(new FakeVoiceChat());

    const calls = await run(h);

    expect(methods(calls)).toEqual(['deferReply', 'followUp']);
    expect(isEphemeral(calls[1]?.options)).toBe(true);
    expect(contentOf(calls[1]?.options)).toMatch(/^Tables are played in a thread/);
    expect(h.channel.threadsStarted).toEqual([]);
    expect(h.next).not.toHaveBeenCalled();
  });

  it('opens nothing once the bot is shutting down', async () => {
    const h = setUp();
    await h.context.tables.closeAll();

    const calls = await run(h);

    expect(contentOf(calls.at(-1)?.options)).toBe(
      'All-in is restarting. Try again in a minute; nothing was bet.',
    );
    expect(h.channel.threadsStarted).toEqual([]);
    expect(h.next).not.toHaveBeenCalled();
  });

  it('only logs a confirmation that cannot be sent; the table stays open', async () => {
    const h = setUp();

    await run(h, {}, (interaction) => {
      Object.assign(interaction, {
        editReply: () => Promise.reject(new Error('Unknown Webhook')),
      });
    });

    expect(h.logs.lines.filter((line) => line.level === 40).map((line) => line.msg)).toEqual([
      'could not confirm a new table',
    ]);
    expect(h.logs.lines.filter((line) => line.level === 50)).toEqual([]);
    expect(h.context.tables.allHosts()).toHaveLength(1);
  });
});
