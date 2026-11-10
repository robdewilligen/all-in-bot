import { DiscordAPIError, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { loggableError, replyWithError } from '../../src/bot/errors.js';
import { PlayerError } from '../../src/core/errors.js';
import { t } from '../../src/i18n/index.js';
import { captureLogs } from '../helpers/context.js';
import { fakeButton, fakeChatInput, GUILD_ID, USER_ID } from '../helpers/discord.js';

const TOKEN = 'aW50ZXJhY3Rpb246c2VjcmV0LXRva2Vu';
const INTERACTION_ID = '400000000000000001';

function unknownInteraction(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 10062, message: 'Unknown interaction' },
    10062,
    404,
    'POST',
    `https://discord.com/api/v10/interactions/${INTERACTION_ID}/${TOKEN}/callback`,
    { body: { type: 4, data: { content: 'Something went wrong' } } },
  );
}

const generic = { content: t('en-US', 'errors.generic'), flags: MessageFlags.Ephemeral };

describe('replyWithError', () => {
  it('shows a PlayerError as its own ephemeral message and does not log it', async () => {
    const { interaction, calls } = fakeChatInput('spin');
    const { logger, lines } = captureLogs();
    const params = { needed: '🪙 100', balance: '🪙 40' };

    await replyWithError(interaction, new PlayerError('errors.insufficientFunds', params), logger);

    expect(calls).toEqual([
      {
        method: 'reply',
        options: {
          content: t('en-US', 'errors.insufficientFunds', params),
          flags: MessageFlags.Ephemeral,
        },
      },
    ]);
    expect(lines).toEqual([]);
  });

  it('logs an unexpected error with its context and gives the player the generic message', async () => {
    const { interaction, calls } = fakeChatInput('balance');
    const { logger, lines } = captureLogs();

    await replyWithError(interaction, new Error('database down'), logger);

    expect(calls).toEqual([{ method: 'reply', options: generic }]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'interaction failed',
        guildId: GUILD_ID,
        userId: USER_ID,
        command: 'balance',
        err: expect.objectContaining({ message: 'database down' }) as unknown,
      }),
    ]);
  });

  it.each(['deferReply', 'reply'] as const)(
    'follows up ephemerally when the interaction was answered with %s',
    async (first) => {
      const { interaction, calls } = fakeChatInput('balance');
      if (first === 'deferReply') await interaction.deferReply();
      else await interaction.reply({ content: 'Counting your coins…' });

      await replyWithError(interaction, new Error('boom'), captureLogs().logger);

      expect(calls.map((call) => call.method)).toEqual([first, 'followUp']);
      expect(calls[1]?.options).toEqual(generic);
    },
  );

  it('logs the custom ID of a failed button press', async () => {
    const { interaction } = fakeButton('bj:7:hit:3');
    const { logger, lines } = captureLogs();

    await replyWithError(interaction, new Error('boom'), logger);

    expect(lines[0]).toMatchObject({ guildId: GUILD_ID, userId: USER_ID, customId: 'bj:7:hit:3' });
  });

  it('survives a reply that fails and logs it without the interaction token', async () => {
    const { interaction } = fakeChatInput('balance');
    Object.assign(interaction, { reply: () => Promise.reject(unknownInteraction()) });
    const { logger, lines } = captureLogs();

    await expect(replyWithError(interaction, new Error('boom'), logger)).resolves.toBeUndefined();

    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      [50, 'interaction failed'],
      [40, 'could not send the error reply'],
    ]);
    expect(lines[1]).toMatchObject({
      command: 'balance',
      err: {
        code: 10062,
        status: 404,
        url: `https://discord.com/api/v10/interactions/${INTERACTION_ID}/:token/callback`,
      },
    });
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('survives a failing reply to a PlayerError too', async () => {
    const { interaction } = fakeChatInput('spin');
    Object.assign(interaction, { reply: () => Promise.reject(unknownInteraction()) });
    const { logger, lines } = captureLogs();

    await expect(
      replyWithError(interaction, new PlayerError('errors.guildOnly'), logger),
    ).resolves.toBeUndefined();

    expect(lines.map((line) => line.msg)).toEqual(['could not send the error reply']);
  });
});

describe('loggableError', () => {
  it('passes other errors through unchanged', () => {
    const error = new Error('boom');

    expect(loggableError(error)).toBe(error);
    expect(loggableError('a string')).toBe('a string');
  });

  it('removes the token and the request body from a Discord REST error', () => {
    const webhook = new DiscordAPIError(
      { code: 50035, message: 'Invalid Form Body' },
      50035,
      400,
      'POST',
      `https://discord.com/api/v10/webhooks/900000000000000001/${TOKEN}/messages/@original`,
      { body: { content: 'secret-ish' } },
    );
    const { logger, lines } = captureLogs();

    logger.error({ err: loggableError(webhook) }, 'failed');

    expect(lines[0]?.err).toMatchObject({
      message: 'Invalid Form Body',
      name: 'DiscordAPIError[50035]',
      code: 50035,
      status: 400,
      method: 'POST',
      url: 'https://discord.com/api/v10/webhooks/900000000000000001/:token/messages/@original',
    });
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain('secret-ish');
  });
});
