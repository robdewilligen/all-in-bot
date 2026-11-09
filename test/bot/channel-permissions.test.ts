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

const { Administrator, EmbedLinks, SendMessages, SendMessagesInThreads, ViewChannel } =
  PermissionFlagsBits;

describe('missingTablePermissions', () => {
  it('finds nothing missing when the channel grants what a table needs', () => {
    const { interaction } = fakeChatInput('roulette');

    expect(missingTablePermissions(interaction)).toEqual([]);
  });

  it.each([
    ['ViewChannel', ViewChannel],
    ['SendMessages', SendMessages],
    ['EmbedLinks', EmbedLinks],
  ] as const)('names %s when it is missing', (name, bit) => {
    const { interaction } = fakeChatInput('roulette', { appPermissions: TABLE_PERMISSIONS & ~bit });

    expect(missingTablePermissions(interaction)).toEqual([name]);
  });

  it('names every missing permission', () => {
    const { interaction } = fakeChatInput('roulette', { appPermissions: 0n });

    expect(missingTablePermissions(interaction)).toEqual([
      'ViewChannel',
      'SendMessages',
      'EmbedLinks',
    ]);
  });

  it('needs Send Messages in Threads instead of Send Messages inside a thread', () => {
    const withoutThreads = fakeChatInput('roulette', { inThread: true });
    const withThreads = fakeChatInput('roulette', {
      inThread: true,
      appPermissions: ViewChannel | SendMessagesInThreads | EmbedLinks,
    });

    expect(missingTablePermissions(withoutThreads.interaction)).toEqual(['SendMessagesInThreads']);
    expect(missingTablePermissions(withThreads.interaction)).toEqual([]);
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
      'SendMessagesInThreads',
      'EmbedLinks',
    ]);

    expect(translate('en-US', message)).toBe(
      "I can't open a table in this channel. I'm missing: View Channel, Send Messages in Threads, Embed Links.",
    );
  });

  it('reaches the player as an ephemeral error through a PlayerError', async () => {
    const { interaction, calls } = fakeChatInput('roulette', {
      appPermissions: TABLE_PERMISSIONS & ~EmbedLinks,
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
          content: "I can't open a table in this channel. I'm missing: Embed Links.",
          flags: MessageFlags.Ephemeral,
        },
      },
    ]);
  });
});
