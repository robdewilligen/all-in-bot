import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Message,
  type MessageCreateOptions,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';
import { PlayerError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { loggableError } from '../errors.js';

/** A channel a table can start its thread in (SPEC §4). */
export type TableParent = TextChannel | NewsChannel;

/** The thread a table lives in, as far as a table uses it. */
export interface TableThread {
  readonly id: string;
  readonly url: string;
  setArchived(archived?: boolean, reason?: string): Promise<unknown>;
  setName(name: string, reason?: string): Promise<unknown>;
  send(options: MessageCreateOptions): Promise<Message<true>>;
}

/**
 * Message edits don't keep a thread awake, and a table plays game after game, so a day. A closed
 * table archives its thread itself; this only covers an archive Discord refused.
 */
export const THREAD_ARCHIVE_AFTER = ThreadAutoArchiveDuration.OneDay;

interface CommandChannel {
  readonly channelId: string;
  readonly channel: GuildTextBasedChannel | null;
}

/** The channel a command counts as for seating: inside a thread, the channel the thread is in. */
export function seatingChannelId({ channelId, channel }: CommandChannel): string {
  return channel?.isThread() === true && channel.parentId !== null ? channel.parentId : channelId;
}

/**
 * The channel a new table opens its thread in: the command's channel, or inside a thread the
 * channel that thread is in. Throws a PlayerError where threads can't be started, such as the chat
 * of a voice channel or a forum post.
 */
export function tableParentOf({ channel }: CommandChannel): TableParent {
  const home = channel?.isThread() === true ? channel.parent : channel;
  if (home?.type === ChannelType.GuildText || home?.type === ChannelType.GuildAnnouncement) {
    return home;
  }
  throw new PlayerError('errors.noThreads');
}

/** Whether the player can see a channel, and so open a link to a table's thread there. */
export function channelsVisibleTo({
  member,
  guild,
}: Pick<ChatInputCommandInteraction<'cached'>, 'member' | 'guild'>): (
  channelId: string,
) => boolean {
  return (channelId) =>
    guild.channels.cache
      .get(channelId)
      ?.permissionsFor(member)
      ?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

/** Starts a table's public thread; it posts nothing in the channel itself. */
export async function openTableThread(parent: TableParent, name: string): Promise<TableThread> {
  return parent.threads.create({
    name,
    autoArchiveDuration: THREAD_ARCHIVE_AFTER,
    reason: 'An All-in table opened',
  });
}

/**
 * Archives a closed table's thread. Never throws: when Discord refuses, the thread archives itself
 * after THREAD_ARCHIVE_AFTER without messages.
 */
export async function archiveTableThread(thread: TableThread, logger: Logger): Promise<void> {
  try {
    await thread.setArchived(true, 'The All-in table closed');
  } catch (error) {
    logger.warn(
      { threadId: thread.id, err: loggableError(error) },
      'could not archive a table thread',
    );
  }
}

const LOST_CODES: ReadonlySet<number | string> = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
  RESTJSONErrorCodes.InvalidActionOnArchivedThread,
]);

/**
 * Whether an edit failed because the table can't be shown any more: its message or thread was
 * deleted, the thread was archived, or the bot lost access. With only the Guilds intent the bot
 * hears of none of that except a deleted thread, so a failed edit is how a table finds out.
 */
export function isLostTableError(error: unknown): boolean {
  return error instanceof DiscordAPIError && LOST_CODES.has(error.code);
}
