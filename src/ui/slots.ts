import { EmbedBuilder } from 'discord.js';
import { gameConfig } from '../config/game.js';
import type { InstantResult } from '../core/wallet.js';
import {
  createSlotMachine,
  PAYLINE_ROW,
  type ExactRtp,
  type PaytableLine,
  type SlotSpin,
  type SlotSymbol,
  type SlotWindow,
} from '../games/slots/index.js';
import { formatCoins, formatCount } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { colors } from './colors.js';

const machine = createSlotMachine(gameConfig.slots);
let exact: ExactRtp | undefined;

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function symbolText(locale: string, symbol: SlotSymbol): string {
  return t(locale, `slots.symbols.${symbol}`);
}

function windowText(locale: string, window: SlotWindow): string {
  return window
    .map((row, index) => {
      const symbols = row.map((symbol) => symbolText(locale, symbol)).join(' ');
      return index === PAYLINE_ROW ? t(locale, 'slots.payline', { symbols }) : symbols;
    })
    .join('\n');
}

function outcomeText(locale: string, win: PaytableLine | null): string {
  if (win === null) return t(locale, 'slots.noWin');
  const values = {
    count: formatCount(win.count),
    symbol: symbolText(locale, win.symbol),
    multiplier: formatCount(win.multiplier),
  };
  return win.multiplier >= gameConfig.slots.jackpotFrom
    ? t(locale, 'slots.jackpot', values)
    : t(locale, 'slots.win', values);
}

function netText(locale: string, net: number): string {
  if (net > 0) return t(locale, 'slots.netWin', { amount: formatCoins(net) });
  if (net < 0) return t(locale, 'slots.netLoss', { amount: formatCoins(-net) });
  return formatCoins(0);
}

function netColor(net: number): number {
  if (net > 0) return colors.win;
  if (net < 0) return colors.loss;
  return colors.breakEven;
}

/** A frame of the reveal, while at least one reel is still spinning. */
export function slotsSpinningEmbed(
  locale: string,
  window: SlotWindow,
  stake: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(colors.inProgress)
    .setTitle(t(locale, 'slots.title'))
    .setDescription(`${windowText(locale, window)}\n\n${t(locale, 'slots.spinning')}`)
    .addFields({ name: t(locale, 'slots.bet'), value: formatCoins(stake), inline: true });
}

/** The settled spin (SPEC §8): the winning combination, bet, winnings, new balance and net result. */
export function slotsResultEmbed(
  locale: string,
  window: SlotWindow,
  result: InstantResult<SlotSpin>,
): EmbedBuilder {
  const net = result.payout - result.stake;
  return new EmbedBuilder()
    .setColor(netColor(net))
    .setTitle(t(locale, 'slots.title'))
    .setDescription(`${windowText(locale, window)}\n\n${outcomeText(locale, result.details.win)}`)
    .addFields(
      { name: t(locale, 'slots.bet'), value: formatCoins(result.stake), inline: true },
      { name: t(locale, 'slots.winnings'), value: formatCoins(result.payout), inline: true },
      { name: t(locale, 'slots.balance'), value: formatCoins(result.balance), inline: true },
      { name: t(locale, 'slots.net'), value: netText(locale, net), inline: true },
    );
}

/** The slots topic of /help (SPEC §9): the paytable and the exact payout percentage. */
export function slotsHelpEmbed(locale: string): EmbedBuilder {
  // Every stop combination is worked out once; the reels and paytable never change at runtime.
  exact ??= machine.exactRtp();
  const { combinations, returned, wins } = exact;
  const lines = machine.paytable.map(({ symbol, count, multiplier }) => {
    const values = {
      symbols: Array.from({ length: count }, () => symbolText(locale, symbol)).join(' '),
      multiplier: formatCount(multiplier),
    };
    return count === machine.reels.length
      ? t(locale, 'slots.help.line', values)
      : t(locale, 'slots.help.anywhere', values);
  });
  return new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(t(locale, 'slots.help.title'))
    .setDescription(t(locale, 'slots.help.description'))
    .addFields(
      { name: t(locale, 'slots.help.paytable'), value: lines.join('\n') },
      {
        name: t(locale, 'slots.help.payout'),
        value: t(locale, 'slots.help.payoutText', {
          rtp: percent.format(returned / combinations),
          winRate: percent.format(wins / combinations),
        }),
      },
    );
}
