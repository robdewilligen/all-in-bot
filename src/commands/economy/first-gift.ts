import type { ChatInputCommandInteraction } from 'discord.js';
import { playerOf } from '../../bot/player.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import type { AppContext, Command } from '../../bot/types.js';
import { t } from '../../i18n/index.js';
import { firstGiftReply } from '../../ui/economy.js';

export default {
  data: guildSlashCommand('first-gift', t('en', 'commands.firstgift.description')),
  async execute(
    interaction: ChatInputCommandInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    const claim = await context.wallet.claimFirstGift(playerOf(interaction));
    await interaction.reply(firstGiftReply(interaction.locale, interaction.user.id, claim));
  },
} satisfies Command;
