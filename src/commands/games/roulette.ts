import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';
import { balanceForAutocomplete } from '../../bot/bet-autocomplete.js';
import { interactionContext, loggableError } from '../../bot/errors.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import { playRoulette } from '../../bot/tables/roulette-table.js';
import type { AppContext, Command } from '../../bot/types.js';
import { t } from '../../i18n/index.js';
import { rouletteChoices } from '../../ui/roulette.js';

/** SPEC §3: the bets option takes at most 500 characters. */
const BETS_MAX_LENGTH = 500;

export default {
  data: guildSlashCommand('roulette', t('en', 'roulette.command.description')).addStringOption(
    (option) =>
      option
        .setName('bets')
        .setDescription(t('en', 'roulette.command.bets'))
        .setRequired(true)
        .setMaxLength(BETS_MAX_LENGTH)
        .setAutocomplete(true),
  ),

  /** The live preview of SPEC §6. Never throws. */
  async autocomplete(
    interaction: AutocompleteInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    let choices: ApplicationCommandOptionChoiceData<string>[] = [];
    try {
      const typed = interaction.options.getFocused();
      const balance = await balanceForAutocomplete(interaction, context);
      choices = rouletteChoices(typed, balance, interaction.locale);
    } catch (error) {
      context.logger.error(
        { ...interactionContext(interaction), err: loggableError(error) },
        'autocomplete failed',
      );
    }
    try {
      await interaction.respond(choices);
    } catch (error) {
      context.logger.warn(
        { ...interactionContext(interaction), err: loggableError(error) },
        'could not answer autocomplete',
      );
    }
  },

  execute(interaction: ChatInputCommandInteraction<'cached'>, context: AppContext): Promise<void> {
    return playRoulette(interaction, interaction.options.getString('bets', true), context);
  },
} satisfies Command;
