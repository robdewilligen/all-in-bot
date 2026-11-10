import { randomInt } from 'node:crypto';
import type { ChatInputCommandInteraction } from 'discord.js';
import { respondWithBetChoices } from '../../bot/bet-autocomplete.js';
import { interactionContext, loggableError } from '../../bot/errors.js';
import { playerOf } from '../../bot/player.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import type { AppContext, Command } from '../../bot/types.js';
import { gameConfig } from '../../config/game.js';
import { parseAmount, stakeLimitError } from '../../core/amount.js';
import { PlayerError } from '../../core/errors.js';
import type { InstantResult } from '../../core/wallet.js';
import { createSlotMachine, type Draw, type SlotSpin } from '../../games/slots/index.js';
import { t } from '../../i18n/index.js';
import { slotsResultEmbed, slotsSpinningEmbed } from '../../ui/slots.js';

const machine = createSlotMachine(gameConfig.slots);
const draw: Draw = (max) => randomInt(max);

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function stakeFor(
  interaction: ChatInputCommandInteraction<'cached'>,
  context: AppContext,
): Promise<number> {
  const balance = await context.wallet.balanceOf(playerOf(interaction));
  const parsed = parseAmount(interaction.options.getString('bet', true), {
    balance,
    max: gameConfig.stakes.max,
  });
  if (!parsed.ok) throw new PlayerError(...parsed.error);
  const outside = stakeLimitError(parsed.amount, gameConfig.stakes);
  if (outside !== null) throw new PlayerError(...outside);
  return parsed.amount;
}

/**
 * Shows a settled spin: every reel spinning, then one reel stopping per edit, the last edit with
 * the result. The round is already settled, so a failed reply or edit is logged, never reported
 * to the player as a failed spin.
 */
async function reveal(
  interaction: ChatInputCommandInteraction<'cached'>,
  context: AppContext,
  result: InstantResult<SlotSpin>,
): Promise<void> {
  const { locale } = interaction;
  const { stops } = result.details;
  const reels = machine.reels.length;
  const log = { ...interactionContext(interaction), roundId: result.roundId };
  try {
    const spinning = slotsSpinningEmbed(locale, machine.frame(stops, 0, draw), result.stake);
    await interaction.reply({ embeds: [spinning] });
  } catch (error) {
    context.logger.error({ ...log, err: loggableError(error) }, 'could not show a settled spin');
    return;
  }
  for (let stopped = 1; stopped <= reels; stopped += 1) {
    await pause(gameConfig.slots.revealDelayMs);
    const embed =
      stopped < reels
        ? slotsSpinningEmbed(locale, machine.frame(stops, stopped, draw), result.stake)
        : slotsResultEmbed(locale, machine.window(stops), result);
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      context.logger.warn({ ...log, err: loggableError(error) }, 'could not edit the slots reveal');
    }
  }
}

export default {
  data: guildSlashCommand('spin', t('en', 'slots.command.description')).addStringOption((option) =>
    option
      .setName('bet')
      .setDescription(t('en', 'slots.command.bet'))
      .setRequired(true)
      .setAutocomplete(true),
  ),
  autocomplete: respondWithBetChoices,
  async execute(
    interaction: ChatInputCommandInteraction<'cached'>,
    context: AppContext,
  ): Promise<void> {
    const stake = await stakeFor(interaction, context);
    // Settled before anything is shown (SPEC §4), so a PlayerError can still be ephemeral.
    const result = await context.wallet.playInstant(playerOf(interaction), 'slots', stake, () => {
      const spin = machine.spin(draw);
      return { payout: stake * spin.multiplier, details: spin };
    });
    await reveal(interaction, context, result);
  },
} satisfies Command;
