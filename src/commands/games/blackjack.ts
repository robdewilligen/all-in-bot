import type { ChatInputCommandInteraction } from 'discord.js';
import { respondWithBetChoices } from '../../bot/bet-autocomplete.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import { playBlackjack } from '../../bot/tables/blackjack-table.js';
import type { AppContext, Command } from '../../bot/types.js';
import { t } from '../../i18n/index.js';

export default {
  data: guildSlashCommand('blackjack', t('en', 'blackjack.command.description')).addStringOption(
    (option) =>
      option
        .setName('bet')
        .setDescription(t('en', 'blackjack.command.bet'))
        .setRequired(true)
        .setAutocomplete(true),
  ),
  autocomplete: respondWithBetChoices,
  async execute(
    interaction: ChatInputCommandInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    await playBlackjack(interaction, interaction.options.getString('bet', true), context);
  },
} satisfies Command;
