import type { ChatInputCommandInteraction } from 'discord.js';
import { playerOf } from '../../bot/player.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import type { AppContext, Command } from '../../bot/types.js';
import { t } from '../../i18n/index.js';
import { dailyGiftReply } from '../../ui/economy.js';

export default {
  data: guildSlashCommand('dailygift', t('en', 'commands.dailygift.description')),
  async execute(
    interaction: ChatInputCommandInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    const claim = await context.wallet.claimDaily(playerOf(interaction), context.clock());
    await interaction.reply(dailyGiftReply(interaction.locale, interaction.user.id, claim));
  },
} satisfies Command;
