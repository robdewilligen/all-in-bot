import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type APIEmbedField,
} from 'discord.js';
import type { RefundResult } from '../bot/tables/refunds.js';
import { gameConfig } from '../config/game.js';
import type {
  BlackjackRules,
  Card,
  DealerView,
  HandOutcome,
  HandView,
  InsuranceView,
  PlayerAction,
  RoundPhase,
  RoundView,
  SeatView,
  Turn,
} from '../games/blackjack/index.js';
import { discordTimestamp, formatCoins, formatCount } from '../i18n/format.js';
import { t } from '../i18n/index.js';
import { colors } from './colors.js';

const rules: BlackjackRules = gameConfig.blackjack;

/** Every button action on a table message, the third part of `bj:<tableId>:<action>:<step>`. */
export const TABLE_ACTIONS = [
  'same',
  'change',
  'leave',
  'insure',
  'noInsure',
  'even',
  'noEven',
  'hit',
  'stand',
  'double',
  'split',
  'surrender',
] as const satisfies readonly string[];

export type TableAction = (typeof TABLE_ACTIONS)[number];

export function isTableAction(value: string): value is TableAction {
  return (TABLE_ACTIONS as readonly string[]).includes(value);
}

/** The text input of the Change bet modal. */
export const BET_FIELD = 'amount';

export type TablePhase = 'betting' | 'insurance' | 'turns' | 'closed';

/**
 * Why the game ended. `settleFailed`: its last round could not be settled, and the snapshot's
 * `refund` says what became of the stakes. `lost`: the message or its thread is gone, so nobody
 * sees the closed table.
 */
export type ClosedReason = 'empty' | 'restart' | 'settleFailed' | 'lost';

export type SeatStatus =
  | 'betPlaced'
  | 'leaving'
  | 'noBet'
  | 'noBetSatOut'
  | 'playing'
  | 'playingLeaving'
  | 'sittingOut'
  | 'nextRound';

/** A seat as the description lists it. `bet` is what Same bet places, or the bet in play. */
export interface SeatLine {
  readonly number: number;
  readonly name: string;
  readonly bet: number;
  readonly status: SeatStatus;
  readonly sitOuts: number;
}

/** A player in a round, by engine seat ID; net and balance come in once the round is settled. */
export interface RoundPlayer {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly net: number | null;
  readonly balance: number | null;
}

export interface RoundDisplay {
  readonly view: RoundView;
  readonly players: readonly RoundPlayer[];
  /** The settled previous round, shown while the next one takes bets. */
  readonly last: boolean;
}

/** A turn button: disabled when the hand may not take the action or the player can't afford it. */
export interface TurnButton {
  readonly action: PlayerAction;
  readonly cost: number;
  readonly enabled: boolean;
}

/** Everything the table message shows, as plain data. */
export interface TableSnapshot {
  /** The table thread's number, as in "Table #12". */
  readonly tableNumber: number;
  readonly phase: TablePhase;
  readonly closedReason: ClosedReason | null;
  /** When the running phase or turn times out. */
  readonly deadline: Temporal.Instant | null;
  readonly seats: readonly SeatLine[];
  /** The round in play, or the last one while betting. */
  readonly round: RoundDisplay | null;
  /** After a failed settlement: what became of that round's stakes. */
  readonly refund: RefundResult | null;
  readonly cardsLeft: number;
  readonly turnButtons: readonly TurnButton[];
  readonly customId: (action: TableAction) => string;
}

export interface TableMessage {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export interface SeatedReply {
  readonly seat: number;
  readonly bet: number;
  /** Placed on the round that is taking bets now; otherwise it is the bet for the next round. */
  readonly placed: boolean;
  readonly url: string;
}

interface Totals {
  readonly total: number;
  readonly soft: boolean;
  readonly blackjack: boolean;
  readonly bust: boolean;
}

// Masked links aren't escaped by default, and a name like [x](url) would render as a link.
export function escapedName(name: string): string {
  return escapeMarkdown(name, { maskedLink: true });
}

function ratioText(locale: string): string {
  return t(locale, 'blackjack.ratio', {
    numerator: formatCount(rules.blackjackPays.numerator),
    denominator: formatCount(rules.blackjackPays.denominator),
  });
}

export function cardText(locale: string, card: Card): string {
  return t(locale, 'blackjack.cards.card', {
    rank: t(locale, `blackjack.cards.ranks.${card.rank}`),
    suit: t(locale, `blackjack.cards.suits.${card.suit}`),
  });
}

function cardsText(locale: string, cards: readonly Card[]): string {
  return cards.map((card) => cardText(locale, card)).join(' ');
}

/** A hand's total as players read it: "17", "soft 17", "Blackjack!" or "24, bust". */
export function totalText(locale: string, hand: Totals): string {
  const total = formatCount(hand.total);
  if (hand.blackjack) return t(locale, 'blackjack.totals.blackjack');
  if (hand.bust) return t(locale, 'blackjack.totals.bust', { total });
  return hand.soft
    ? t(locale, 'blackjack.totals.soft', { total })
    : t(locale, 'blackjack.totals.hard', { total });
}

function outcomeText(locale: string, outcome: HandOutcome): string {
  switch (outcome) {
    case 'blackjack':
      return t(locale, 'blackjack.outcomes.blackjack', { ratio: ratioText(locale) });
    case 'evenMoney':
      return t(locale, 'blackjack.outcomes.evenMoney');
    case 'win':
      return t(locale, 'blackjack.outcomes.win');
    case 'push':
      return t(locale, 'blackjack.outcomes.push');
    case 'lose':
      return t(locale, 'blackjack.outcomes.lose');
    case 'surrender':
      return t(locale, 'blackjack.outcomes.surrender');
  }
}

function netText(locale: string, net: number): string {
  if (net > 0) return t(locale, 'blackjack.table.netWin', { amount: formatCoins(net) });
  if (net < 0) return t(locale, 'blackjack.table.netLoss', { amount: formatCoins(-net) });
  return formatCoins(0);
}

function dealerText(locale: string, dealer: DealerView): string {
  if (dealer.holeCardHidden) {
    return `${cardsText(locale, dealer.cards)} ${t(locale, 'blackjack.cards.hidden')}`;
  }
  return t(locale, 'blackjack.table.dealerHand', {
    cards: cardsText(locale, dealer.cards),
    total: totalText(locale, dealer),
  });
}

function handText(locale: string, hand: HandView, active: boolean): string {
  const values = {
    cards: cardsText(locale, hand.cards),
    total: totalText(locale, hand),
    bet: formatCoins(hand.bet),
  };
  let text = hand.doubled
    ? t(locale, 'blackjack.table.handDoubled', values)
    : t(locale, 'blackjack.table.hand', values);
  if (hand.result !== null) {
    text = t(locale, 'blackjack.table.handResult', {
      hand: text,
      outcome: outcomeText(locale, hand.result.outcome),
    });
  }
  return active ? t(locale, 'blackjack.table.handActive', { hand: text }) : text;
}

/** The insurance line of a seat; null when there is nothing to say. */
function insuranceText(
  locale: string,
  insurance: InsuranceView | null,
  phase: RoundPhase,
): string | null {
  if (insurance === null) return null;
  const answering = phase === 'insurance';
  if (insurance.kind === 'evenMoney') {
    // After the peek the hand's result says whether even money was paid.
    if (insurance.answer === 'pending') return t(locale, 'blackjack.insurance.evenMoneyOffer');
    if (!answering) return null;
    return insurance.answer === 'taken'
      ? t(locale, 'blackjack.insurance.evenMoneyTaken')
      : t(locale, 'blackjack.insurance.evenMoneyDeclined');
  }
  const cost = formatCoins(insurance.cost);
  switch (insurance.answer) {
    case 'pending':
      return t(locale, 'blackjack.insurance.offer', { cost });
    case 'declined':
      return answering ? t(locale, 'blackjack.insurance.declined') : null;
    case 'taken':
      if (insurance.payout === null) return t(locale, 'blackjack.insurance.taken', { cost });
      return insurance.payout > 0
        ? t(locale, 'blackjack.insurance.paid', { payout: formatCoins(insurance.payout) })
        : t(locale, 'blackjack.insurance.lost', { cost });
  }
}

function seatText(
  locale: string,
  seat: SeatView,
  player: RoundPlayer | undefined,
  view: RoundView,
): string {
  const lines = [t(locale, 'blackjack.table.player', { name: escapedName(player?.name ?? '') })];
  seat.hands.forEach((hand, index) => {
    const active = view.turn?.seatId === seat.id && view.turn.hand === index;
    lines.push(handText(locale, hand, active));
  });
  const insurance = insuranceText(locale, seat.insurance, view.phase);
  if (insurance !== null) lines.push(insurance);
  const net = player?.net ?? null;
  const balance = player?.balance ?? null;
  if (net !== null && balance !== null) {
    lines.push(
      t(locale, 'blackjack.table.net', {
        net: netText(locale, net),
        balance: formatCoins(balance),
      }),
    );
  }
  if (seat.timedOut) lines.push(t(locale, 'blackjack.table.stoodAutomatically'));
  return lines.join('\n');
}

function roundFields(locale: string, round: RoundDisplay): APIEmbedField[] {
  const { view } = round;
  const dealer: APIEmbedField = {
    name: round.last
      ? t(locale, 'blackjack.table.lastDealer')
      : t(locale, 'blackjack.table.dealer'),
    value: dealerText(locale, view.dealer),
  };
  const seats = view.seats.map((seat) => {
    const player = round.players.find((candidate) => candidate.id === seat.id);
    return {
      name: t(locale, 'blackjack.table.seat', { seat: formatCount(player?.number ?? 0) }),
      value: seatText(locale, seat, player, view),
    };
  });
  return [dealer, ...seats];
}

function statusText(locale: string, seat: SeatLine): string {
  const counts = {
    count: formatCount(seat.sitOuts),
    max: formatCount(gameConfig.blackjackTable.maxSitOuts),
  };
  switch (seat.status) {
    case 'betPlaced':
      return t(locale, 'blackjack.status.betPlaced');
    case 'leaving':
      return t(locale, 'blackjack.status.leaving');
    case 'noBet':
      return t(locale, 'blackjack.status.noBet');
    case 'noBetSatOut':
      return t(locale, 'blackjack.status.noBetSatOut', counts);
    case 'playing':
      return t(locale, 'blackjack.status.playing');
    case 'playingLeaving':
      return t(locale, 'blackjack.status.playingLeaving');
    case 'sittingOut':
      return t(locale, 'blackjack.status.sittingOut', counts);
    case 'nextRound':
      return t(locale, 'blackjack.status.nextRound');
  }
}

function seatLineText(locale: string, seat: SeatLine): string {
  return t(locale, 'blackjack.table.seatLine', {
    seat: formatCount(seat.number),
    name: escapedName(seat.name),
    bet: formatCoins(seat.bet),
    status: statusText(locale, seat),
  });
}

function settleFailedText(locale: string, refund: RefundResult | null): string {
  switch (refund) {
    case 'pending':
      return t(locale, 'blackjack.table.closedRefundPending');
    case 'settled':
      return t(locale, 'blackjack.table.closedSettledLate');
    case 'refunded':
    case null:
      return t(locale, 'blackjack.table.closedRefunded');
  }
}

function closedText(locale: string, table: TableSnapshot): string {
  switch (table.closedReason) {
    case 'settleFailed':
      return settleFailedText(locale, table.refund);
    case 'restart':
      return t(locale, 'blackjack.table.closedRestart');
    case 'empty':
    case 'lost':
    case null:
      return t(locale, 'blackjack.table.closedEmpty');
  }
}

function activePlayer(round: RoundDisplay | null, turn: Turn | null): string {
  const player = round?.players.find((candidate) => candidate.id === turn?.seatId);
  return escapedName(player?.name ?? '');
}

function descriptionText(locale: string, table: TableSnapshot): string {
  if (table.phase === 'closed') return closedText(locale, table);
  const time = table.deadline === null ? '' : discordTimestamp(table.deadline);
  const lines: string[] = [];
  switch (table.phase) {
    case 'betting':
      lines.push(t(locale, 'blackjack.table.bettingOpen', { time }));
      break;
    case 'insurance':
      lines.push(t(locale, 'blackjack.table.insuranceOpen', { time }));
      break;
    case 'turns':
      lines.push(
        t(locale, 'blackjack.table.turn', {
          player: activePlayer(table.round, table.round?.view.turn ?? null),
          time,
        }),
      );
      break;
  }
  if (table.seats.length > 0)
    lines.push('', ...table.seats.map((seat) => seatLineText(locale, seat)));
  return lines.join('\n');
}

function footerText(locale: string, cardsLeft: number): string {
  const values = {
    decks: formatCount(rules.decks),
    ratio: ratioText(locale),
    cards: formatCount(cardsLeft),
  };
  return rules.dealerHitsSoft17
    ? t(locale, 'blackjack.table.footerH17', values)
    : t(locale, 'blackjack.table.footerS17', values);
}

function button(
  table: TableSnapshot,
  action: TableAction,
  label: string,
  style: ButtonStyle,
  enabled = true,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(table.customId(action))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(!enabled);
}

/** The one amount every seat still to bet would place, so it can go on the Same bet button. */
function sharedAmount(amounts: readonly number[]): number | null {
  const [first] = amounts;
  return first !== undefined && amounts.every((amount) => amount === first) ? first : null;
}

function bettingButtons(locale: string, table: TableSnapshot): ButtonBuilder[] {
  const waiting = table.seats.filter(
    (seat) => seat.status === 'noBet' || seat.status === 'noBetSatOut',
  );
  const amount = sharedAmount(waiting.map((seat) => seat.bet));
  const same =
    amount === null
      ? t(locale, 'blackjack.buttons.sameBet')
      : t(locale, 'blackjack.buttons.sameBetAmount', { bet: formatCoins(amount) });
  return [
    button(table, 'same', same, ButtonStyle.Success),
    button(table, 'change', t(locale, 'blackjack.buttons.changeBet'), ButtonStyle.Primary),
    button(table, 'leave', t(locale, 'blackjack.buttons.leave'), ButtonStyle.Secondary),
  ];
}

function insuranceButtons(locale: string, table: TableSnapshot): ButtonBuilder[] {
  const pending = (table.round?.view.seats ?? []).flatMap((seat) =>
    seat.insurance?.answer === 'pending' ? [seat.insurance] : [],
  );
  const insurance = pending.filter((offer) => offer.kind === 'insurance');
  const buttons: ButtonBuilder[] = [];
  if (insurance.length > 0) {
    const cost = sharedAmount(insurance.map((offer) => offer.cost));
    const label =
      cost === null
        ? t(locale, 'blackjack.buttons.insurance')
        : t(locale, 'blackjack.buttons.insuranceCost', { cost: formatCoins(cost) });
    buttons.push(
      button(table, 'insure', label, ButtonStyle.Primary),
      button(table, 'noInsure', t(locale, 'blackjack.buttons.noInsurance'), ButtonStyle.Secondary),
    );
  }
  if (pending.some((offer) => offer.kind === 'evenMoney')) {
    buttons.push(
      button(table, 'even', t(locale, 'blackjack.buttons.evenMoney'), ButtonStyle.Success),
      button(table, 'noEven', t(locale, 'blackjack.buttons.noEvenMoney'), ButtonStyle.Secondary),
    );
  }
  return buttons;
}

function turnButton(locale: string, table: TableSnapshot, turn: TurnButton): ButtonBuilder {
  const cost = formatCoins(turn.cost);
  switch (turn.action) {
    case 'hit':
      return button(
        table,
        'hit',
        t(locale, 'blackjack.buttons.hit'),
        ButtonStyle.Primary,
        turn.enabled,
      );
    case 'stand':
      return button(
        table,
        'stand',
        t(locale, 'blackjack.buttons.stand'),
        ButtonStyle.Secondary,
        turn.enabled,
      );
    case 'double':
      return button(
        table,
        'double',
        t(locale, 'blackjack.buttons.double', { cost }),
        ButtonStyle.Success,
        turn.enabled,
      );
    case 'split':
      return button(
        table,
        'split',
        t(locale, 'blackjack.buttons.split', { cost }),
        ButtonStyle.Success,
        turn.enabled,
      );
    case 'surrender':
      return button(
        table,
        'surrender',
        t(locale, 'blackjack.buttons.surrender'),
        ButtonStyle.Danger,
        turn.enabled,
      );
  }
}

function buttonsFor(locale: string, table: TableSnapshot): ButtonBuilder[] {
  switch (table.phase) {
    case 'betting':
      return bettingButtons(locale, table);
    case 'insurance':
      return insuranceButtons(locale, table);
    case 'turns':
      return table.turnButtons.map((turn) => turnButton(locale, table, turn));
    case 'closed':
      return [];
  }
}

/** While betting, the fields show the last round, so its results stay readable (SPEC §7). */
export function blackjackTableMessage(locale: string, table: TableSnapshot): TableMessage {
  const embed = new EmbedBuilder()
    .setColor(table.phase === 'closed' ? colors.breakEven : colors.inProgress)
    .setTitle(t(locale, 'blackjack.table.title', { number: table.tableNumber }))
    .setDescription(descriptionText(locale, table))
    .setFooter({ text: footerText(locale, table.cardsLeft) });
  if (table.round !== null) embed.addFields(roundFields(locale, table.round));
  const buttons = buttonsFor(locale, table);
  const components =
    buttons.length === 0 ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
  return { embeds: [embed], components };
}

/** The Change bet modal, with the current bet filled in. */
export function blackjackBetModal(locale: string, customId: string, bet: number): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(BET_FIELD)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setPlaceholder(t(locale, 'blackjack.modal.placeholder'))
    .setValue(String(bet));
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(t(locale, 'blackjack.modal.title'))
    .addLabelComponents(
      new LabelBuilder().setLabel(t(locale, 'blackjack.modal.label')).setTextInputComponent(input),
    );
}

/**
 * The ephemeral answer to /blackjack and the bet form: the seat, the bet and a link to the table
 * message. `elsewhere`: the table is in another channel than the player's.
 */
export function blackjackSeatReply(
  locale: string,
  seated: SeatedReply,
  elsewhere: boolean,
): string {
  const { url } = seated;
  const values = {
    seat: formatCount(seated.seat),
    bet: formatCoins(seated.bet),
    link: elsewhere
      ? t(locale, 'blackjack.reply.elsewhere', { url })
      : t(locale, 'blackjack.reply.link', { url }),
  };
  return seated.placed
    ? t(locale, 'blackjack.reply.placed', values)
    : t(locale, 'blackjack.reply.nextRound', values);
}

/** The blackjack topic of /help (SPEC §9): the rules, the seats and the buttons. */
export function blackjackHelpEmbed(locale: string): EmbedBuilder {
  const table = gameConfig.blackjackTable;
  const { stakes } = gameConfig;
  const ruleLines = [
    t(locale, 'blackjack.help.decks', {
      decks: formatCount(rules.decks),
      cut: formatCount(rules.cutCardPercent),
    }),
    rules.dealerHitsSoft17
      ? t(locale, 'blackjack.help.dealerH17')
      : t(locale, 'blackjack.help.dealerS17'),
    t(locale, 'blackjack.help.payout', { ratio: ratioText(locale) }),
    t(locale, 'blackjack.help.insurance'),
    rules.doubleAfterSplit
      ? t(locale, 'blackjack.help.doubleAfterSplit')
      : t(locale, 'blackjack.help.doubleNoSplit'),
    t(locale, 'blackjack.help.split', { hands: formatCount(rules.maxHands) }),
  ];
  if (rules.lateSurrender) ruleLines.push(t(locale, 'blackjack.help.surrender'));
  return new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(t(locale, 'blackjack.help.title'))
    .setDescription(t(locale, 'blackjack.help.description', { seats: formatCount(table.seats) }))
    .addFields(
      { name: t(locale, 'blackjack.help.rules'), value: ruleLines.join('\n') },
      {
        name: t(locale, 'blackjack.help.seats'),
        value: t(locale, 'blackjack.help.seatsText', {
          betting: formatCount(table.bettingSeconds),
          min: formatCoins(stakes.min),
          max: formatCoins(stakes.max),
          sitOuts: formatCount(table.maxSitOuts),
        }),
      },
      {
        name: t(locale, 'blackjack.help.turns'),
        value: t(locale, 'blackjack.help.turnsText', {
          insurance: formatCount(table.insuranceSeconds),
          turn: formatCount(table.turnSeconds),
        }),
      },
    );
}
