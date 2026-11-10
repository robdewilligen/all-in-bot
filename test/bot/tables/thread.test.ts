import { ChannelType, ThreadAutoArchiveDuration } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  archiveTableThread,
  channelsVisibleTo,
  isLostTableError,
  openTableThread,
  seatingChannelId,
  tableParentOf,
  type TableParent,
  type TableThread,
} from '../../../src/bot/tables/thread.js';
import { PlayerError } from '../../../src/core/errors.js';
import { captureLogs } from '../../helpers/context.js';
import {
  CHANNEL_ID,
  discordError,
  fakeChatInput,
  FakeChannel,
  type FakeThread,
} from '../../helpers/discord.js';

type CommandChannel = Parameters<typeof tableParentOf>[0];

function inChannel(channel: unknown, channelId = CHANNEL_ID): CommandChannel {
  return { channelId, channel } as unknown as CommandChannel;
}

async function threadIn(parent: FakeChannel): Promise<FakeThread> {
  return parent.threads.create({ name: 'Table #1' });
}

function asTableThread(thread: FakeThread): TableThread {
  return thread as unknown as TableThread;
}

describe('seatingChannelId', () => {
  it("is the command's channel, or the channel a thread is in", async () => {
    const casino = new FakeChannel('casino');
    const thread = await threadIn(casino);

    expect(seatingChannelId(inChannel(casino, 'casino'))).toBe('casino');
    expect(seatingChannelId(inChannel(thread, thread.id))).toBe('casino');
    expect(seatingChannelId(inChannel(null, 'uncached'))).toBe('uncached');
  });
});

describe('tableParentOf', () => {
  it('opens a table in a text or announcement channel, and from a thread in its channel', async () => {
    const casino = new FakeChannel('casino');
    const thread = await threadIn(casino);
    const news = { type: ChannelType.GuildAnnouncement, isThread: () => false };

    expect(tableParentOf(inChannel(casino))).toBe(casino);
    expect(tableParentOf(inChannel(thread))).toBe(casino);
    expect(tableParentOf(inChannel(news))).toBe(news);
  });

  const voice = { type: ChannelType.GuildVoice, isThread: (): boolean => false };
  const forumPost = {
    isThread: (): boolean => true,
    parentId: 'forum',
    parent: { type: ChannelType.GuildForum },
  };

  it.each([
    ['the chat of a voice channel', voice],
    ['a forum post', forumPost],
    ['an uncached channel', null],
  ] as const)('refuses %s with a player error', (_where, channel) => {
    expect(() => tableParentOf(inChannel(channel))).toThrow(PlayerError);
    expect(() => tableParentOf(inChannel(channel))).toThrow('errors.noThreads');
  });
});

describe('channelsVisibleTo', () => {
  it('tells the channels the member can see from the ones hidden from them', () => {
    const { interaction } = fakeChatInput('roulette', { hiddenChannels: ['staff'] });
    const canView = channelsVisibleTo(interaction);

    expect(canView('casino')).toBe(true);
    expect(canView('staff')).toBe(false);
  });

  it('treats a channel that is not in the cache as hidden', () => {
    const { interaction } = fakeChatInput('roulette');
    const empty = {
      member: interaction.member,
      guild: { channels: { cache: { get: () => undefined } } },
    };

    expect(channelsVisibleTo(empty as unknown as typeof interaction)('gone')).toBe(false);
  });
});

describe('openTableThread', () => {
  it('starts a public thread with a day of auto-archive and posts nothing in the channel', async () => {
    const casino = new FakeChannel('casino');

    const thread = await openTableThread(casino as unknown as TableParent, 'Table #4 (Roulette)');

    expect(casino.threadsStarted).toHaveLength(1);
    expect(casino.threadsStarted[0]).toBe(thread);
    expect(casino.threadsStarted[0]?.name).toBe('Table #4 (Roulette)');
    expect(casino.threadsStarted[0]?.autoArchiveDuration).toBe(ThreadAutoArchiveDuration.OneDay);
    expect(casino.messages).toEqual([]);
  });
});

describe('archiveTableThread', () => {
  it('archives the thread', async () => {
    const thread = await threadIn(new FakeChannel('casino'));

    await archiveTableThread(asTableThread(thread), captureLogs().logger);

    expect(thread.archived).toBe(true);
  });

  it('only logs when Discord refuses, so closing a table never fails on it', async () => {
    const thread = await threadIn(new FakeChannel('casino'));
    thread.archiveError = discordError(50013, 403);
    const { logger, lines } = captureLogs();

    await expect(archiveTableThread(asTableThread(thread), logger)).resolves.toBeUndefined();

    expect(thread.archived).toBe(false);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        threadId: thread.id,
        msg: 'could not archive a table thread',
      }),
    ]);
  });
});

describe('isLostTableError', () => {
  it.each([10003, 10008, 50001, 50013, 50083])('is true for Discord error %i', (code) => {
    expect(isLostTableError(discordError(code))).toBe(true);
  });

  it('is false for other Discord errors and for anything else', () => {
    expect(isLostTableError(discordError(50035, 400))).toBe(false);
    expect(isLostTableError(new Error('Unknown Message'))).toBe(false);
    expect(isLostTableError({ code: 10008 })).toBe(false);
  });
});
