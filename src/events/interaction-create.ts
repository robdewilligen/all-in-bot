import {
  Events,
  type AnySelectMenuInteraction,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  interactionContext,
  loggableError,
  replyEphemeral,
  replyWithError,
} from '../bot/errors.js';
import { playerOf } from '../bot/player.js';
import type { AppContext, BotEvent } from '../bot/types.js';
import { gameConfig } from '../config/game.js';
import { PlayerError } from '../core/errors.js';
import { discordTimestamp } from '../i18n/format.js';
import { t } from '../i18n/index.js';

async function runCommand(
  interaction: ChatInputCommandInteraction,
  context: AppContext,
): Promise<void> {
  try {
    if (!interaction.inCachedGuild()) throw new PlayerError('errors.guildOnly');
    const command = interaction.client.commands.get(interaction.commandName);
    if (command === undefined) {
      context.logger.warn(interactionContext(interaction), 'unknown command');
      await replyEphemeral(interaction, t(interaction.locale, 'errors.generic'));
      return;
    }
    const end = context.cooldowns.hit(
      {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        command: interaction.commandName,
      },
      command.cooldown ?? gameConfig.cooldowns.defaultSeconds,
      context.clock().epochMilliseconds,
    );
    if (end !== null) {
      throw new PlayerError('errors.cooldown', {
        command: interaction.commandName,
        time: discordTimestamp(Temporal.Instant.fromEpochMilliseconds(end)),
      });
    }
    await context.wallet.touchPlayer(playerOf(interaction));
    await command.execute(interaction, context);
  } catch (error) {
    await replyWithError(interaction, error, context.logger);
  }
}

async function runAutocomplete(
  interaction: AutocompleteInteraction,
  context: AppContext,
): Promise<void> {
  try {
    const command = interaction.client.commands.get(interaction.commandName);
    if (command?.autocomplete === undefined || !interaction.inCachedGuild()) {
      await interaction.respond([]);
      return;
    }
    await command.autocomplete(interaction, context);
  } catch (error) {
    context.logger.error(
      { ...interactionContext(interaction), err: loggableError(error) },
      'autocomplete failed',
    );
    if (interaction.responded) return;
    try {
      await interaction.respond([]);
    } catch (respondError) {
      context.logger.warn(
        { ...interactionContext(interaction), err: loggableError(respondError) },
        'could not answer autocomplete',
      );
    }
  }
}

/** A button or modal that reached this handler belongs to a table that no longer exists. */
async function closeStaleComponent(
  interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
  context: AppContext,
): Promise<void> {
  // A live table's collector handles its own presses (and modals it awaits).
  if (context.tables.owns(interaction.guildId, interaction.customId)) return;
  try {
    // A form the live table stopped waiting for: the table is fine, so its buttons stay.
    if (
      interaction.isModalSubmit() &&
      context.tables.isLive(interaction.guildId, interaction.customId)
    ) {
      await replyEphemeral(interaction, t(interaction.locale, 'errors.formExpired'));
      return;
    }
    const notice = t(interaction.locale, 'errors.tableClosed');
    if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
      await replyEphemeral(interaction, notice);
      return;
    }
    await interaction.update({ components: [] });
    await replyEphemeral(interaction, notice);
  } catch (error) {
    await replyWithError(interaction, error, context.logger);
  }
}

export default {
  name: Events.InteractionCreate,
  async execute(context, interaction) {
    if (interaction.isChatInputCommand()) await runCommand(interaction, context);
    else if (interaction.isAutocomplete()) await runAutocomplete(interaction, context);
    else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      await closeStaleComponent(interaction, context);
    }
  },
} satisfies BotEvent<Events.InteractionCreate>;
