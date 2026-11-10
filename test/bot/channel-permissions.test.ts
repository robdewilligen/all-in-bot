import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  missingPermissionsMessage,
  missingTablePermissions,
} from '../../src/bot/channel-permissions.js';
import { replyWithError } from '../../src/bot/errors.js';
import { PlayerError } from '../../src/core/errors.js';
import { translate } from '../../src/i18n/index.js';
import { captureLogs } from '../helpers/context.js';
import { fakeChatInput, TABLE_PERMISSIONS } from '../helpers/discord.js';

const {
  Administrator,
  CreatePublicThreads,
  EmbedLinks,
  SendMessages,
  SendMessagesInThreads,
  ViewChannel,
} = PermissionFlagsBits;

describe('missingTablePermissions', () => {
  it('finds nothing missing when the channel grants what a table thread needs', () => {
    const { interaction } = fakeChatInput('roulette');

    expect(missingTablePermissions(interaction)).toEqual([]);
  });

  it.each([
    ['ViewChannel', ViewChannel],
    ['CreatePublicThreads', CreatePublicThreads],
    ['SendMessagesInThreads', SendMessagesInThreads],
    ['EmbedLinks', EmbedLinks],
  ] as const)('names %s when it is missing', (name, bit) => {
    const { interaction } = fakeChatInput('roulette', { appPermissions: TABLE_PERMISSIONS & ~bit });

    expect(missingTablePermissions(interaction)).toEqual([name]);
  });

  it('names every missing permission, and Send Messages is not one of them', () => {
    const { interaction } = fakeChatInput('roulette', { appPermissions: SendMessages });

    expect(missingTablePermissions(interaction)).toEqual([
      'ViewChannel',
      'CreatePublicThreads',
      'SendMessagesInThreads',
      'EmbedLinks',
    ]);
  });

  it('asks the same inside a thread, which has the permissions of its channel', () => {
    const { interaction } = fakeChatInput('roulette', { inThread: true });

    expect(missingTablePermissions(interaction)).toEqual([]);
  });

  it('finds nothing missing for an administrator', () => {
    const { interaction } = fakeChatInput('roulette', { appPermissions: Administrator });

    expect(missingTablePermissions(interaction)).toEqual([]);
  });
});

describe('missingPermissionsMessage', () => {
  it('names each missing permission for the player', () => {
    const message = missingPermissionsMessage('en-US', [
      'ViewChannel',
      'CreatePublicThreads',
      'SendMessagesInThreads',
      'EmbedLinks',
    ]);

    expect(translate('en-US', message)).toBe(
      "I can't open a table in this channel. I'm missing: View Channel, Create Public Threads, Send Messages in Threads, Embed Links.",
    );
  });

  it('reaches the player as an ephemeral error through a PlayerError', async () => {
    const { interaction, calls } = fakeChatInput('roulette', {
      appPermissions: TABLE_PERMISSIONS & ~CreatePublicThreads,
    });
    const missing = missingTablePermissions(interaction);

    await replyWithError(
      interaction,
      new PlayerError(...missingPermissionsMessage(interaction.locale, missing)),
      captureLogs().logger,
    );

    expect(calls).toEqual([
      {
        method: 'reply',
        options: {
          content: "I can't open a table in this channel. I'm missing: Create Public Threads.",
          flags: MessageFlags.Ephemeral,
        },
      },
    ]);
  });
});
