import type { PermissionsBitField, PermissionsString } from 'discord.js';
import { t, type Message } from '../i18n/index.js';

/** The permissions a table message needs in its channel (SPEC §4). */
export type TablePermission = Extract<
  PermissionsString,
  'ViewChannel' | 'SendMessages' | 'SendMessagesInThreads' | 'EmbedLinks'
>;

interface ChannelInteraction {
  /** The app's permissions in the interaction's channel, overwrites included. */
  readonly appPermissions: Readonly<PermissionsBitField>;
  readonly channel: { isThread(): boolean } | null;
}

/** The table permissions the app lacks in the interaction's channel; empty when it has them all. */
export function missingTablePermissions(interaction: ChannelInteraction): TablePermission[] {
  const send = interaction.channel?.isThread() === true ? 'SendMessagesInThreads' : 'SendMessages';
  const needed: readonly TablePermission[] = ['ViewChannel', send, 'EmbedLinks'];
  return needed.filter((permission) => !interaction.appPermissions.has(permission));
}

/** The player-facing error naming each missing permission, for a PlayerError or translate(). */
export function missingPermissionsMessage(
  locale: string,
  missing: readonly TablePermission[],
): Message {
  const names = missing.map((permission) => t(locale, `permissions.${permission}`));
  return ['errors.missingPermissions', { permissions: names.join(', ') }];
}
