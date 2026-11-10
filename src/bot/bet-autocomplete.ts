import type { AutocompleteInteraction } from 'discord.js';
import { gameConfig } from '../config/game.js';
import {
  amountKeyword,
  parseAmount,
  stakeLimitError,
  type AmountKeyword,
  type StakeLimits,
} from '../core/amount.js';
import { formatCoins } from '../i18n/format.js';
import { t, translate, type Message } from '../i18n/index.js';
import { CHOICE_LIMIT, clipChoice as clip } from '../ui/choices.js';
import { interactionContext, loggableError } from './errors.js';
import type { AppContext } from './types.js';

export interface BetChoice {
  readonly name: string;
  readonly value: string;
}

function amountName(keyword: AmountKeyword | null, amount: number, locale: string): string {
  const coins = formatCoins(amount);
  switch (keyword) {
    case null:
      return coins;
    case 'all':
      return t(locale, 'amount.choiceAll', { amount: coins });
    case 'max':
      return t(locale, 'amount.choiceMax', { amount: coins });
    case 'half':
      return t(locale, 'amount.choiceHalf', { amount: coins });
  }
}

function errorName(error: Message, locale: string): string {
  // A choice name is plain text: Discord would show markdown backticks literally.
  const reason = translate(locale, error).replaceAll('`', '');
  return t(locale, 'amount.choiceError', { error: reason });
}

function typedName(text: string, balance: number, limits: StakeLimits, locale: string): string {
  const parsed = parseAmount(text, { balance, max: limits.max });
  if (!parsed.ok) return errorName(parsed.error, locale);
  const outside = stakeLimitError(parsed.amount, limits);
  if (outside !== null) return errorName(outside, locale);
  return amountName(parsed.keyword, parsed.amount, locale);
}

/**
 * The choices for a `bet` option (SPEC §4): what the typed text comes to (or why it won't work),
 * with the text as its value, then All-in (Max when the balance is above the maximum) and Half.
 * Keyword choices outside the stake limits are left out. With a null balance (it couldn't be read)
 * only typed text that isn't a keyword gets a choice.
 */
export function betChoices(
  typed: string,
  balance: number | null,
  limits: StakeLimits,
  locale: string,
): BetChoice[] {
  const text = typed.trim();
  // Too long for a value, and a keyword choice in its place could be picked by mistake.
  if (text.length > CHOICE_LIMIT) return [];
  const typedKeyword = amountKeyword(text);
  const choices: BetChoice[] = [];
  if (text !== '' && (balance !== null || typedKeyword === null)) {
    // Only keywords read the balance.
    choices.push({ name: clip(typedName(text, balance ?? 0, limits, locale)), value: text });
  }
  if (balance === null) return choices;
  const keywords: AmountKeyword[] = [balance > limits.max ? 'max' : 'all', 'half'];
  for (const keyword of keywords) {
    if (keyword === typedKeyword) continue;
    const parsed = parseAmount(keyword, { balance, max: limits.max });
    if (parsed.ok && stakeLimitError(parsed.amount, limits) === null) {
      choices.push({ name: clip(amountName(keyword, parsed.amount, locale)), value: keyword });
    }
  }
  return choices;
}

/** Discord drops an autocomplete answer after 3 seconds (SPEC §4); a slower balance is skipped. */
export const BALANCE_TIMEOUT_MS = 2_000;

/** The player's balance for an autocomplete answer, or null when it failed or came too late. */
export async function balanceForAutocomplete(
  interaction: AutocompleteInteraction<'cached'>,
  context: AppContext,
): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, BALANCE_TIMEOUT_MS);
  });
  try {
    const balance = await Promise.race([
      context.wallet.balanceOf({ guildId: interaction.guildId, userId: interaction.user.id }),
      timeout,
    ]);
    if (balance !== 'timeout') return balance;
    context.logger.warn(
      interactionContext(interaction),
      'reading the balance for autocomplete took too long',
    );
    return null;
  } catch (error) {
    context.logger.error(
      { ...interactionContext(interaction), err: loggableError(error) },
      'could not read the balance for autocomplete',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answers the autocomplete of a `bet` option (SPEC §4): the parsed value of what was typed, plus
 * All-in (or Max) and Half from the live balance. Never throws.
 */
export async function respondWithBetChoices(
  interaction: AutocompleteInteraction<'cached'>,
  context: AppContext,
): Promise<void> {
  let choices: BetChoice[] = [];
  try {
    const typed = interaction.options.getFocused();
    const balance = await balanceForAutocomplete(interaction, context);
    choices = betChoices(typed, balance, gameConfig.stakes, interaction.locale);
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
}
