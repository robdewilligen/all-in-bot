import type { ChatInputCommandInteraction } from 'discord.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import type { AppContext, Command } from '../../bot/types.js';
import { t } from '../../i18n/index.js';
import { balanceReply } from '../../ui/economy.js';

export default {
  data: guildSlashCommand('balance', t('en', 'commands.balance.description')).addUserOption(
    (option) => option.setName('player').setDescription(t('en', 'commands.balance.player')),
  ),
  async execute(
    interaction: ChatInputCommandInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    const player = interaction.options.getUser('player') ?? interaction.user;
    // standingOf only reads, so looking someone up never creates a row for them (SPEC §5).
    const standing = await context.wallet.standingOf({
      guildId: interaction.guildId,
      userId: player.id,
    });
    await interaction.reply(balanceReply(interaction.locale, player.id, standing));
  },
} satisfies Command;
