import type { ChatInputCommandInteraction } from 'discord.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import type { AppContext, Command } from '../../bot/types.js';
import { gameConfig } from '../../config/game.js';
import { t } from '../../i18n/index.js';
import { leaderboardReply } from '../../ui/economy.js';

export default {
  data: guildSlashCommand(
    'leaderboard',
    t('en', 'commands.leaderboard.description'),
  ).addIntegerOption((option) =>
    option.setName('page').setDescription(t('en', 'commands.leaderboard.page')).setMinValue(1),
  ),
  cooldown: gameConfig.cooldowns.leaderboardSeconds,
  async execute(
    interaction: ChatInputCommandInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    const { guildId } = interaction;
    const [board, callerStanding] = await Promise.all([
      context.wallet.leaderboard(guildId, interaction.options.getInteger('page') ?? 1),
      context.wallet.standingOf({ guildId, userId: interaction.user.id }),
    ]);
    await interaction.reply(leaderboardReply(interaction.locale, board, callerStanding));
  },
} satisfies Command;
