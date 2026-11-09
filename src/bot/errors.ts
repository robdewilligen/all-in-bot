import {
  DiscordAPIError,
  HTTPError,
  MessageFlags,
  type Interaction,
  type RepliableInteraction,
} from 'discord.js';
import { PlayerError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { t, translate } from '../i18n/index.js';

export interface InteractionLogContext {
  readonly guildId: string | null;
  readonly userId: string;
  readonly command?: string;
  readonly customId?: string;
}

/** What a log line says about an interaction; never the interaction itself, which holds its token. */
export function interactionContext(interaction: Interaction): InteractionLogContext {
  const who = { guildId: interaction.guildId, userId: interaction.user.id };
  if (interaction.isCommand() || interaction.isAutocomplete()) {
    return { ...who, command: interaction.commandName };
  }
  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    return { ...who, customId: interaction.customId };
  }
  return who;
}

const TOKEN_IN_ROUTE = /\/(interactions|webhooks)\/(\d+)\/[^/?]+/g;

/**
 * The error as it may be logged. Discord REST errors carry the request URL, and interaction routes
 * put the interaction token in it, so those are copied without the token and the request body.
 */
export function loggableError(error: unknown): unknown {
  if (!(error instanceof DiscordAPIError || error instanceof HTTPError)) return error;
  return Object.assign(new Error(error.message), {
    name: error.name,
    stack: error.stack,
    status: error.status,
    method: error.method,
    url: error.url.replace(TOKEN_IN_ROUTE, '/$1/$2/:token'),
    ...(error instanceof DiscordAPIError ? { code: error.code } : {}),
  });
}

/** An ephemeral reply, or an ephemeral follow-up when the interaction was replied to or deferred. */
export async function replyEphemeral(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  const options = { content, flags: MessageFlags.Ephemeral } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(options);
  else await interaction.reply(options);
}

/**
 * Tells the player that their interaction failed: a PlayerError with its own message, anything else
 * logged and answered with the generic message. Never throws or rejects.
 */
export async function replyWithError(
  interaction: RepliableInteraction,
  error: unknown,
  logger: Logger,
): Promise<void> {
  try {
    if (error instanceof PlayerError) {
      await replyEphemeral(interaction, translate(interaction.locale, error.userMessage));
      return;
    }
    logger.error(
      { ...interactionContext(interaction), err: loggableError(error) },
      'interaction failed',
    );
    await replyEphemeral(interaction, t(interaction.locale, 'errors.generic'));
  } catch (replyError) {
    logger.warn(
      { ...interactionContext(interaction), err: loggableError(replyError) },
      'could not send the error reply',
    );
  }
}
