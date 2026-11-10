import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import {
  missingPermissionsMessage,
  missingTablePermissions,
} from '../../bot/channel-permissions.js';
import { interactionContext, loggableError } from '../../bot/errors.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import { tableParentOf } from '../../bot/tables/thread.js';
import type { AppContext, Command } from '../../bot/types.js';
import { gameConfig } from '../../config/game.js';
import { PlayerError } from '../../core/errors.js';
import { t } from '../../i18n/index.js';
import { tableCreatedReply } from '../../ui/table.js';

export default {
  data: guildSlashCommand('create-table', t('en', 'tables.command.description')),
  cooldown: gameConfig.cooldowns.createTableSeconds,
  async execute(
    interaction: ChatInputCommandInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    // Ephemeral, so a PlayerError after it stays private; opening may wait for the server's queue.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const missing = missingTablePermissions(interaction);
    if (missing.length > 0) {
      throw new PlayerError(...missingPermissionsMessage(interaction.locale, missing));
    }
    const parent = tableParentOf(interaction);
    const host = await context.tables.inGuild(interaction.guildId, () =>
      context.hosts.open({
        context,
        parent,
        game: null,
        locale: interaction.guildLocale,
        userId: interaction.user.id,
      }),
    );
    try {
      await interaction.editReply({
        content: tableCreatedReply(interaction.locale, host.number, host.url),
      });
    } catch (error) {
      context.logger.warn(
        { ...interactionContext(interaction), err: loggableError(error) },
        'could not confirm a new table',
      );
    }
  },
} satisfies Command;
