import type { PermissionsBitField, PermissionsString } from 'discord.js';
import { t, type Message } from '../i18n/index.js';

/** The permissions a table needs in the channel its thread opens in (SPEC §4). */
export type TablePermission = Extract<
  PermissionsString,
  'ViewChannel' | 'CreatePublicThreads' | 'SendMessagesInThreads' | 'EmbedLinks'
>;

const NEEDED: readonly TablePermission[] = [
  'ViewChannel',
  'CreatePublicThreads',
  'SendMessagesInThreads',
  'EmbedLinks',
];

interface ChannelInteraction {
  /** The app's permissions in the interaction's channel, overwrites included; a thread has its channel's. */
  readonly appPermissions: Readonly<PermissionsBitField>;
}

/** The table permissions the app lacks in the interaction's channel; empty when it has them all. */
export function missingTablePermissions(interaction: ChannelInteraction): TablePermission[] {
  return NEEDED.filter((permission) => !interaction.appPermissions.has(permission));
}

/** The player-facing error naming each missing permission, for a PlayerError or translate(). */
export function missingPermissionsMessage(
  locale: string,
  missing: readonly TablePermission[],
): Message {
  const names = missing.map((permission) => t(locale, `permissions.${permission}`));
  return ['errors.missingPermissions', { permissions: names.join(', ') }];
}
