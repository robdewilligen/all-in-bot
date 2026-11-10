import {
  EmbedBuilder,
  escapeMarkdown,
  inlineCode,
  type ApplicationCommandOptionChoiceData,
} from 'discord.js';
import type { RefundResult } from '../bot/tables/refunds.js';
import { gameConfig } from '../config/game.js';
import {
  colorOf,
  parseBets,
  type AnnouncedBetKind,
  type RouletteBet,
  type SettledBet,
  type TableBetKind,
} from '../games/roulette/index.js';
import { discordTimestamp, formatCoins } from '../i18n/format.js';
import { t, translate } from '../i18n/index.js';
import { CHOICE_LIMIT, clipChoice } from './choices.js';
import { colors } from './colors.js';

/** What the empty-field hint sends when picked: not a bet, so the reply explains the notation. */
const HINT_VALUE = 'help';

const TABLE_KINDS: readonly TableBetKind[] = [
  'straight',
  'split',
  'street',
  'trio',
  'corner',
  'firstFour',
  'sixLine',
  'dozen',
  'column',
  'evenMoney',
];

const ANNOUNCED_KINDS: readonly AnnouncedBetKind[] = [
  'voisins',
  'tiers',
  'orphelins',
  'jeuZero',
  'neighbours',
];

/** A player at the table, as the table message lists them. */
export interface SeatView {
  readonly name: string;
  readonly stake: number;
  readonly bets: number;
}

/** A player's line in the table's result. */
export interface SeatResult {
  readonly name: string;
  readonly stake: number;
  readonly payout: number;
}

/** A player's bets on the coming spin, for their confirmation. */
export interface BetsSoFar {
  readonly bets: readonly RouletteBet[];
  readonly stake: number;
  readonly count: number;
  readonly spinsAt: Temporal.Instant;
  readonly url: string;
}

/** One player's settled spin, for their own result. */
export interface PlayerResult {
  readonly result: number;
  readonly bets: readonly SettledBet[];
  readonly stake: number;
  readonly payout: number;
  readonly balance: number;
}

function playerName(name: string): string {
  return escapeMarkdown(name, { maskedLink: true });
}

function betCount(locale: string, count: number): string {
  return count === 1
    ? t(locale, 'roulette.betCount.one')
    : t(locale, 'roulette.betCount.other', { count });
}

function betName(locale: string, bet: RouletteBet): string {
  switch (bet.kind) {
    case 'voisins':
    case 'tiers':
    case 'orphelins':
    case 'jeuZero':
      return t(locale, `roulette.announced.${bet.kind}`);
    case 'neighbours':
      return t(locale, 'roulette.announced.neighbours', { number: bet.label.slice(1) });
    default:
      return inlineCode(bet.label);
  }
}

function pocketText(locale: string, result: number): string {
  return t(locale, `roulette.pockets.${colorOf(result)}`, { number: result });
}

function netText(locale: string, net: number): string {
  if (net > 0) return t(locale, 'roulette.result.netWin', { amount: formatCoins(net) });
  if (net < 0) return t(locale, 'roulette.result.netLoss', { amount: formatCoins(-net) });
  return formatCoins(0);
}

function netColor(net: number): number {
  if (net > 0) return colors.win;
  if (net < 0) return colors.loss;
  return colors.breakEven;
}

function totalStake(seats: readonly { readonly stake: number }[]): number {
  return seats.reduce((sum, seat) => sum + seat.stake, 0);
}

function seatLines(locale: string, seats: readonly SeatView[]): string[] {
  return seats.map((seat) =>
    t(locale, 'roulette.table.player', {
      name: playerName(seat.name),
      stake: formatCoins(seat.stake),
      bets: betCount(locale, seat.bets),
    }),
  );
}

function tableEmbed(
  locale: string,
  color: number,
  status: string,
  lines: readonly string[],
): EmbedBuilder {
  const description = lines.length === 0 ? status : [status, '', ...lines].join('\n');
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(t(locale, 'roulette.table.title'))
    .setDescription(description);
}

function totalField(locale: string, seats: readonly SeatView[]): { name: string; value: string } {
  return { name: t(locale, 'roulette.table.total'), value: formatCoins(totalStake(seats)) };
}

/** The table message while betting is open: its players, their stakes and the countdown. */
export function rouletteBettingEmbed(
  locale: string,
  seats: readonly SeatView[],
  maxPlayers: number,
  spinsAt: Temporal.Instant,
): EmbedBuilder {
  return tableEmbed(
    locale,
    colors.inProgress,
    t(locale, 'roulette.table.betting'),
    seatLines(locale, seats),
  ).addFields(
    {
      name: t(locale, 'roulette.table.players'),
      value: t(locale, 'roulette.table.playerCount', { count: seats.length, max: maxPlayers }),
      inline: true,
    },
    { ...totalField(locale, seats), inline: true },
    { name: t(locale, 'roulette.table.spins'), value: discordTimestamp(spinsAt), inline: true },
  );
}

/** The table message once the spin is settled, before the result shows. */
export function rouletteRollingEmbed(locale: string, seats: readonly SeatView[]): EmbedBuilder {
  return tableEmbed(
    locale,
    colors.inProgress,
    t(locale, 'roulette.table.rolling'),
    seatLines(locale, seats),
  ).addFields(totalField(locale, seats));
}

/** The settled spin (SPEC §6): the number and its colour, and each player's stake, payout and net. */
export function rouletteResultEmbed(
  locale: string,
  result: number,
  players: readonly SeatResult[],
): EmbedBuilder {
  const lines = players.map((player) =>
    t(locale, 'roulette.table.playerResult', {
      name: playerName(player.name),
      stake: formatCoins(player.stake),
      payout: formatCoins(player.payout),
      net: netText(locale, player.payout - player.stake),
    }),
  );
  return tableEmbed(locale, colors.info, pocketText(locale, result), lines);
}

function cancelledText(locale: string, refund: RefundResult): string {
  switch (refund) {
    case 'refunded':
      return t(locale, 'roulette.table.cancelled');
    case 'pending':
      return t(locale, 'roulette.table.cancelledPending');
    case 'settled':
      return t(locale, 'roulette.table.cancelledSettled');
  }
}

/** The table message after a spin that couldn't be settled, saying what became of the stakes. */
export function rouletteCancelledEmbed(
  locale: string,
  refund: RefundResult,
  seats: readonly SeatView[],
): EmbedBuilder {
  return tableEmbed(locale, colors.info, cancelledText(locale, refund), seatLines(locale, seats));
}

/** The table message of a table closed at shutdown; the startup refund returns its stakes. */
export function rouletteClosedEmbed(locale: string, seats: readonly SeatView[]): EmbedBuilder {
  return tableEmbed(
    locale,
    colors.info,
    t(locale, 'roulette.table.closed'),
    seatLines(locale, seats),
  );
}

/** The player's ephemeral confirmation: their bets so far, the total and a link to the table. */
export function rouletteBetsEmbed(
  locale: string,
  placed: BetsSoFar,
  elsewhere: boolean,
): EmbedBuilder {
  const lines = placed.bets.map((bet) =>
    t(locale, 'roulette.bet', { amount: formatCoins(bet.amount), bet: betName(locale, bet) }),
  );
  const link = elsewhere
    ? t(locale, 'roulette.confirmation.elsewhere', { url: placed.url })
    : t(locale, 'roulette.confirmation.here', { url: placed.url });
  return new EmbedBuilder()
    .setColor(colors.inProgress)
    .setTitle(t(locale, 'roulette.confirmation.title'))
    .setDescription(
      [
        ...lines,
        '',
        t(locale, 'roulette.confirmation.total', {
          total: formatCoins(placed.stake),
          bets: betCount(locale, placed.count),
        }),
        t(locale, 'roulette.confirmation.spins', { time: discordTimestamp(placed.spinsAt) }),
        link,
      ].join('\n'),
    );
}

/** A player's own result (SPEC §6): every bet won or lost, the totals, new balance and net result. */
export function roulettePlayerResultEmbed(locale: string, outcome: PlayerResult): EmbedBuilder {
  const lines = outcome.bets.map(({ bet, won, payout }) =>
    t(locale, won ? 'roulette.result.won' : 'roulette.result.lost', {
      bet: betName(locale, bet),
      amount: formatCoins(bet.amount),
      payout: formatCoins(payout),
    }),
  );
  const net = outcome.payout - outcome.stake;
  return new EmbedBuilder()
    .setColor(netColor(net))
    .setTitle(t(locale, 'roulette.result.title'))
    .setDescription([pocketText(locale, outcome.result), '', ...lines].join('\n'))
    .addFields(
      { name: t(locale, 'roulette.result.stake'), value: formatCoins(outcome.stake), inline: true },
      {
        name: t(locale, 'roulette.result.payout'),
        value: formatCoins(outcome.payout),
        inline: true,
      },
      {
        name: t(locale, 'roulette.result.balance'),
        value: formatCoins(outcome.balance),
        inline: true,
      },
      { name: t(locale, 'roulette.result.net'), value: netText(locale, net), inline: true },
    );
}

/**
 * The autocomplete of `bets` (SPEC §6): a live preview of what the typed text places, or why it
 * won't parse, with the text as its value; a hint for an empty field; nothing for text over 100
 * characters. With a null balance (it couldn't be read), text with a keyword gets no choice.
 */
export function rouletteChoices(
  typed: string,
  balance: number | null,
  locale: string,
): ApplicationCommandOptionChoiceData<string>[] {
  const text = typed.trim();
  if (text === '') {
    return [{ name: clipChoice(t(locale, 'roulette.autocomplete.hint')), value: HINT_VALUE }];
  }
  if (text.length > CHOICE_LIMIT) return [];
  // Parsed as 0, an unknown balance changes nothing but keywords, which then fail with noCoins.
  const parsed = parseBets(
    text,
    { balance: balance ?? 0, max: gameConfig.stakes.max },
    gameConfig.roulette.maxBetsPerSpin,
  );
  if (!parsed.ok) {
    if (balance === null && parsed.error[0] === 'amount.noCoins') return [];
    const error = translate(locale, parsed.error).replaceAll('`', '');
    return [{ name: clipChoice(t(locale, 'roulette.autocomplete.error', { error })), value: text }];
  }
  const count = parsed.bets.reduce((sum, bet) => sum + bet.countsAs, 0);
  const total = parsed.bets.reduce((sum, bet) => sum + bet.amount, 0);
  const preview = t(locale, 'roulette.autocomplete.preview', {
    bets: betCount(locale, count),
    total: formatCoins(total),
  });
  return [{ name: clipChoice(preview), value: text }];
}

/** The roulette topic of /help (SPEC §9): the notation table, announced bets and a betting round. */
export function rouletteHelpEmbed(locale: string): EmbedBuilder {
  const { roulette, stakes } = gameConfig;
  const kinds = TABLE_KINDS.map((kind) => t(locale, `roulette.help.kinds.${kind}`));
  const announced = ANNOUNCED_KINDS.map((kind) =>
    kind === 'neighbours'
      ? t(locale, 'roulette.help.layouts.neighbours')
      : t(locale, `roulette.help.layouts.${kind}`, {
          name: t(locale, `roulette.announced.${kind}`),
        }),
  );
  return new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(t(locale, 'roulette.help.title'))
    .setDescription(t(locale, 'roulette.help.description'))
    .addFields(
      { name: t(locale, 'roulette.help.bets'), value: kinds.join('\n') },
      { name: t(locale, 'roulette.help.notation'), value: t(locale, 'roulette.help.notationText') },
      {
        name: t(locale, 'roulette.help.announced'),
        value: [t(locale, 'roulette.help.announcedText'), ...announced].join('\n'),
      },
      {
        name: t(locale, 'roulette.help.round'),
        value: t(locale, 'roulette.help.roundText', {
          seconds: roulette.bettingSeconds,
          players: roulette.maxPlayers,
          bets: roulette.maxBetsPerSpin,
          min: formatCoins(stakes.min),
          max: formatCoins(stakes.max),
        }),
      },
    );
}
