import { randomInt } from 'node:crypto';
import {
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type GuildTextBasedChannel,
  type InteractionCollector,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import { gameConfig } from '../../config/game.js';
import { parseAmount, stakeLimitError } from '../../core/amount.js';
import { PlayerError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { PlayerIdentity, SettledRound } from '../../core/wallet.js';
import {
  BlackjackRound,
  Shoe,
  type BlackjackRules,
  type PlayerAction,
  type RoundView,
} from '../../games/blackjack/index.js';
import { formatCoins } from '../../i18n/format.js';
import { t, translate } from '../../i18n/index.js';
import {
  BET_FIELD,
  blackjackBetModal,
  blackjackSeatReply,
  blackjackTableMessage,
  escapedName,
  isTableAction,
  type ClosedReason,
  type RoundDisplay,
  type RoundPlayer,
  type SeatedReply,
  type SeatLine,
  type TableAction,
  type TableMessage,
  type TablePhase,
  type TableSnapshot,
  type TurnButton,
} from '../../ui/blackjack.js';
import { missingPermissionsMessage, missingTablePermissions } from '../channel-permissions.js';
import { interactionContext, loggableError, replyEphemeral, replyWithError } from '../errors.js';
import { playerOf } from '../player.js';
import type { AppContext } from '../types.js';
import type { RefundResult } from './refunds.js';
import { ActionQueue, customIdPrefix, type HostedTable, type LiveTable } from './registry.js';
import type { PlayInteraction, TableHost } from './table.js';
import {
  channelsVisibleTo,
  isLostTableError,
  seatingChannelId,
  tableParentOf,
  type TableParent,
} from './thread.js';

interface TableSettings {
  readonly seats: number;
  readonly bettingSeconds: number;
  readonly insuranceSeconds: number;
  readonly turnSeconds: number;
  readonly maxSitOuts: number;
  readonly betModalSeconds: number;
}

const rules: BlackjackRules = gameConfig.blackjack;
const settings: TableSettings = gameConfig.blackjackTable;
const PREFIX = customIdPrefix('blackjack');
const TURN_ACTIONS = [
  'hit',
  'stand',
  'double',
  'split',
  'surrender',
] as const satisfies readonly PlayerAction[];

type Press = ButtonInteraction<'cached'>;
type BetModal = ModalSubmitInteraction<'cached'>;

interface Seat {
  readonly number: number;
  readonly userId: string;
  name: string;
  /** What Same bet places; `stake` is the bet in play this round. */
  bet: number;
  /** From the wallet's last answer, so the turn buttons need no lookup. */
  balance: number | null;
  sitOuts: number;
  leaving: boolean;
  roundId: number | null;
  stake: number;
}

interface ParsedPress {
  readonly action: TableAction;
  readonly step: number;
}

interface TableOptions {
  readonly context: AppContext;
  readonly guildId: string;
  /** The channel the table's thread is in. */
  readonly channelId: string;
  /** The server's language: the table message is shared. */
  readonly locale: string;
}

/** A table thread's lobby to start the game at, or the channel a new table thread opens in. */
type OpenAt = { readonly host: TableHost } | { readonly parent: TableParent };

interface OpenOptions {
  readonly context: AppContext;
  readonly locale: string;
  readonly at: OpenAt;
  /** The opener, whose bet is placed before anything shows (review finding 6). */
  readonly player: PlayerIdentity;
  readonly stake: number;
  readonly balance: number;
}

/** Where a player sat down, and what their confirmation says. */
interface Seating {
  readonly table: BlackjackTable;
  readonly seated: SeatedReply;
}

/** A typed bet within the stake limits (SPEC §4); throws a PlayerError otherwise. */
export function parseStake(text: string, balance: number): number {
  const parsed = parseAmount(text, { balance, max: gameConfig.stakes.max });
  if (!parsed.ok) throw new PlayerError(...parsed.error);
  const outside = stakeLimitError(parsed.amount, gameConfig.stakes);
  if (outside !== null) throw new PlayerError(...outside);
  return parsed.amount;
}

/** A shared blackjack table (SPEC §7); every press, command and timer runs through its queue. */
export class BlackjackTable implements LiveTable {
  readonly game = 'blackjack';
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly #context: AppContext;
  readonly #log: Logger;
  readonly #locale: string;
  readonly #queue = new ActionQueue();
  readonly #shoe = new Shoe(rules, randomInt);
  readonly #seats: Seat[] = [];
  #host: TableHost | null = null;
  #message: Message<true> | null = null;
  #collector: InteractionCollector<Press> | null = null;
  #closedReason: ClosedReason | null = null;
  /** Bets and insurance answers leave it alone: players make those at the same time. */
  #step = 0;
  #deadline: Temporal.Instant | null = null;
  #timer: NodeJS.Timeout | undefined;
  #timerToken = 0;
  /** The insurance phase or the hand whose turn the running timer covers. */
  #timerKey: string | null = null;
  #round: BlackjackRound | null = null;
  #tableRoundId: number | null = null;
  #last: RoundDisplay | null = null;
  /** Set when the last round could not be settled; that ends the game. */
  #refund: RefundResult | null = null;
  #modals = 0;
  /** Change bet forms nobody submitted in time; interactionCreate answers a late submit. */
  readonly #expiredModals = new Set<string>();

  private constructor(options: TableOptions) {
    this.#context = options.context;
    this.id = options.context.tables.newTableId();
    this.guildId = options.guildId;
    this.channelId = options.channelId;
    this.#locale = options.locale;
    this.#log = options.context.logger.child({
      guildId: this.guildId,
      channelId: this.channelId,
      tableId: this.id,
    });
  }

  /**
   * Starts a game for its first player. Their bet goes first, so a refused bet leaves no thread or
   * message behind; anything that fails after it refunds the bet and undoes the table.
   */
  static async open(options: OpenOptions): Promise<Seating> {
    const { context, player, stake, at } = options;
    // Seating that began before shutdown may get here after closeAll looked (R1).
    if (context.tables.closing) throw new PlayerError('errors.restarting');
    const table = new BlackjackTable({
      context,
      guildId: player.guildId,
      channelId: 'host' in at ? at.host.channelId : at.parent.id,
      locale: options.locale,
    });
    const seat = table.#newSeat(player, stake, options.balance);
    table.#addSeat(seat);
    try {
      await table.#placeBet(seat, stake, player);
    } catch (error) {
      await table.#stop('empty');
      throw error;
    }
    let opened: TableHost | null = null;
    try {
      let host: TableHost;
      if ('host' in at) {
        host = at.host;
      } else {
        opened = await context.hosts.open({
          context,
          parent: at.parent,
          game: 'blackjack',
          locale: options.locale,
          userId: player.userId,
        });
        host = opened;
      }
      table.#host = host;
      host.begin(table);
      host.addPlayer(player.userId);
      table.#openBetting();
      table.#listen(await host.send(table.#render()));
      context.tables.add(table);
    } catch (error) {
      await table.#abandon(opened);
      throw error;
    }
    await table.#queue.run(async () => {
      await table.#closeBettingIfAllBet();
      await table.#edit();
    });
    return { table, seated: table.#seated(seat, stake, true) };
  }

  hasRoom(): boolean {
    return this.#closedReason === null && this.#seats.length < settings.seats;
  }

  answers(customId: string): boolean {
    return !this.#expiredModals.has(customId);
  }

  /** Null when the table filled up or closed before the queue got to this player. */
  join(player: PlayerIdentity, stake: number, balance: number): Promise<SeatedReply | null> {
    return this.#queue.run(async () => {
      if (!this.hasRoom()) return null;
      const seat = this.#newSeat(player, stake, balance);
      this.#addSeat(seat);
      if (this.#round !== null) {
        this.#host?.addPlayer(player.userId);
        await this.#edit();
        return this.#seated(seat, stake, false);
      }
      try {
        await this.#placeBet(seat, stake, player);
      } catch (error) {
        this.#removeSeat(seat);
        if (this.#seats.length === 0) await this.#closeTable('empty');
        await this.#edit();
        throw error;
      }
      this.#host?.addPlayer(player.userId);
      await this.#closeBettingIfAllBet();
      await this.#edit();
      return this.#seated(seat, stake, true);
    });
  }

  changeBet(player: PlayerIdentity, stake: number): Promise<SeatedReply | null> {
    return this.#queue.run(async () => {
      const seat = this.#seatOf(player.userId);
      if (this.#closedReason !== null || seat === undefined) return null;
      seat.name = player.displayName;
      if (this.#round === null && seat.roundId === null) {
        await this.#placeBet(seat, stake, player);
        await this.#closeBettingIfAllBet();
        await this.#edit();
        return this.#seated(seat, stake, true);
      }
      seat.bet = stake;
      seat.leaving = false;
      await this.#edit();
      return this.#seated(seat, stake, false);
    });
  }

  /** Settles nothing: the startup refund returns the open stakes. */
  async close(): Promise<void> {
    if (this.#closedReason !== null) return;
    this.#closedReason = 'restart';
    this.#clearTimer();
    this.#step += 1;
    this.#collector?.stop('closed');
    await this.#queue.run(() => this.#edit());
  }

  #onCollect(press: Press): void {
    void this.#queue
      .run(() => this.#onPress(press))
      .catch((error: unknown) => this.#interactionFailed(press, error));
  }

  /** Our own stops end it with 'closed'; anything else (threadDelete, channelDelete) is a loss. */
  #onEnd(reason: string): void {
    if (reason === 'closed') return;
    void this.#queue
      .run(() => this.#lost(reason))
      .catch((error: unknown) => {
        this.#log.error({ err: loggableError(error) }, 'could not close a lost blackjack table');
      });
  }

  /** Refunds the round in play and leaves the registry, so nobody is seated at it any more. */
  async #lost(reason: string, error?: unknown): Promise<void> {
    if (this.#closedReason !== null) return;
    this.#log.warn({ reason, err: loggableError(error) }, 'the blackjack table lost its message');
    await this.#closeTable('lost');
  }

  async #interactionFailed(interaction: Press | BetModal, error: unknown): Promise<void> {
    await replyWithError(interaction, error, this.#log);
    if (error instanceof PlayerError || this.#closedReason !== null) return;
    // The step may have gone up before the failure; show buttons that work.
    await this.#queue.run(() => this.#edit());
  }

  #parse(customId: string): ParsedPress | null {
    const [prefix, tableId, action, step] = customId.split(':');
    if (prefix !== PREFIX || tableId !== this.id || step === undefined || !/^\d+$/.test(step)) {
      return null;
    }
    return action !== undefined && isTableAction(action) ? { action, step: Number(step) } : null;
  }

  async #onPress(press: Press): Promise<void> {
    const parsed = this.#parse(press.customId);
    if (this.#closedReason !== null || parsed?.step !== this.#step) {
      await press.deferUpdate();
      return;
    }
    const seat = this.#seatOf(press.user.id);
    if (seat !== undefined) seat.name = press.member.displayName;
    switch (parsed.action) {
      case 'same':
        await this.#sameBet(press, seat);
        return;
      case 'change':
        await this.#askBet(press, seat);
        return;
      case 'leave':
        await this.#leave(press, seat);
        return;
      case 'insure':
      case 'noInsure':
      case 'even':
      case 'noEven':
        await this.#answerInsurance(press, seat, parsed.action);
        return;
      default:
        await this.#act(press, parsed.action);
    }
  }

  async #sameBet(press: Press, seat: Seat | undefined): Promise<void> {
    if (this.#round !== null) {
      await press.deferUpdate();
      return;
    }
    if (seat === undefined) {
      await replyEphemeral(press, t(press.locale, 'blackjack.notices.notSeated'));
      return;
    }
    if (seat.roundId !== null) {
      await press.deferUpdate();
      return;
    }
    await this.#placeBet(seat, seat.bet, playerOf(press));
    await this.#closeBettingIfAllBet();
    await this.#respond(press);
  }

  async #askBet(press: Press, seat: Seat | undefined): Promise<void> {
    if (this.#round !== null) {
      await press.deferUpdate();
      return;
    }
    if (seat === undefined) {
      await replyEphemeral(press, t(press.locale, 'blackjack.notices.notSeated'));
      return;
    }
    if (seat.roundId !== null) {
      const bet = formatCoins(seat.stake);
      await replyEphemeral(press, t(press.locale, 'blackjack.notices.alreadyBet', { bet }));
      return;
    }
    this.#modals += 1;
    const customId = `${PREFIX}:${this.id}:bet:${this.#modals}`;
    await press.showModal(blackjackBetModal(press.locale, customId, seat.bet));
    void this.#awaitBet(press, customId);
  }

  /** Waits outside the queue: a player may take a while to type, or never submit. */
  async #awaitBet(press: Press, customId: string): Promise<void> {
    let submit: BetModal;
    try {
      submit = await press.awaitModalSubmit({
        filter: (candidate) =>
          candidate.user.id === press.user.id && candidate.customId === customId,
        time: settings.betModalSeconds * 1000,
      });
    } catch {
      this.#expiredModals.add(customId);
      return;
    }
    // A closed table's modals are answered as stale by interactionCreate.
    if (this.#closedReason !== null) return;
    try {
      // Acknowledged before the queue and the wallet, so the 3 seconds can't run out (finding 10).
      await submit.deferUpdate();
      await this.#queue.run(() => this.#betFromModal(submit));
    } catch (error) {
      await this.#interactionFailed(submit, error);
    }
  }

  async #betFromModal(submit: BetModal): Promise<void> {
    if (this.#closedReason !== null) return;
    const seat = this.#seatOf(submit.user.id);
    if (seat === undefined) {
      await replyEphemeral(submit, t(submit.locale, 'blackjack.notices.notSeated'));
      return;
    }
    seat.name = submit.member.displayName;
    const player = playerOf(submit);
    const balance = await this.#context.wallet.balanceOf(player);
    const stake = parseStake(submit.fields.getTextInputValue(BET_FIELD), balance);
    if (this.#round === null && seat.roundId === null) {
      await this.#placeBet(seat, stake, player);
      await this.#closeBettingIfAllBet();
      await this.#respond(submit);
      return;
    }
    seat.bet = stake;
    await this.#respond(submit);
    const next = formatCoins(stake);
    // Betting is still open when the player bet (Same bet) while the form was up (finding 7).
    const notice =
      this.#round === null && seat.roundId !== null
        ? t(submit.locale, 'blackjack.notices.betStands', { bet: formatCoins(seat.stake), next })
        : t(submit.locale, 'blackjack.notices.betForNextRound', { bet: next });
    await replyEphemeral(submit, notice);
  }

  async #leave(press: Press, seat: Seat | undefined): Promise<void> {
    if (this.#round !== null) {
      await press.deferUpdate();
      return;
    }
    if (seat === undefined) {
      await replyEphemeral(press, t(press.locale, 'blackjack.notices.notSeated'));
      return;
    }
    if (seat.roundId !== null) {
      // The stake is in the round already, so the player plays it and goes after the settlement.
      seat.leaving = true;
      await this.#respond(press);
      await replyEphemeral(press, t(press.locale, 'blackjack.notices.leavingAfterRound'));
      return;
    }
    this.#removeSeat(seat);
    if (this.#seats.length === 0) await this.#closeTable('empty');
    else await this.#closeBettingIfAllBet();
    await this.#respond(press);
  }

  async #answerInsurance(
    press: Press,
    seat: Seat | undefined,
    action: 'insure' | 'noInsure' | 'even' | 'noEven',
  ): Promise<void> {
    const round = this.#round;
    if (round?.phase !== 'insurance') {
      await press.deferUpdate();
      return;
    }
    const roundId = seat?.roundId ?? null;
    if (seat === undefined || roundId === null) {
      await replyEphemeral(press, t(press.locale, 'blackjack.notices.notInRound'));
      return;
    }
    const offer = round.insuranceOffer(seat.userId);
    if (offer === null) {
      await press.deferUpdate();
      return;
    }
    const evenMoney = offer.kind === 'evenMoney';
    if (evenMoney !== (action === 'even' || action === 'noEven')) {
      const notice = evenMoney
        ? t(press.locale, 'blackjack.notices.evenMoneyButtons')
        : t(press.locale, 'blackjack.notices.insuranceButtons');
      await replyEphemeral(press, notice);
      return;
    }
    const take = action === 'insure' || action === 'even';
    if (take && offer.cost > 0) {
      const raised = await this.#context.wallet.raiseRound(roundId, offer.cost);
      seat.balance = raised.balance;
    }
    round.answerInsurance(seat.userId, take);
    await this.#afterRoundChange();
    await this.#respond(press);
  }

  async #act(press: Press, action: PlayerAction): Promise<void> {
    const round = this.#round;
    const turn = round?.turn ?? null;
    if (round === null || turn === null) {
      await press.deferUpdate();
      return;
    }
    const seat = this.#seatIn(turn.seatId);
    if (press.user.id !== turn.seatId) {
      const player = escapedName(seat.name);
      await replyEphemeral(press, t(press.locale, 'blackjack.notices.notYourTurn', { player }));
      return;
    }
    const option = round.actions().find((candidate) => candidate.action === action);
    const roundId = seat.roundId;
    if (option === undefined || roundId === null) {
      await press.deferUpdate();
      return;
    }
    this.#step += 1;
    if (option.cost > 0) {
      try {
        const raised = await this.#context.wallet.raiseRound(roundId, option.cost);
        seat.balance = raised.balance;
      } catch (error) {
        if (!(error instanceof PlayerError)) throw error;
        await this.#refreshBalance(seat);
        await this.#respond(press);
        await replyEphemeral(press, translate(press.locale, error.userMessage));
        return;
      }
    }
    round.act(turn.seatId, action);
    await this.#afterRoundChange();
    await this.#respond(press);
  }

  async #placeBet(seat: Seat, stake: number, player: PlayerIdentity): Promise<void> {
    const { wallet } = this.#context;
    const tableRoundId =
      this.#tableRoundId ?? (await wallet.openTableRound(this.guildId, 'blackjack'));
    this.#tableRoundId = tableRoundId;
    const opened = await wallet.openRound(player, tableRoundId, stake);
    seat.roundId = opened.roundId;
    seat.stake = stake;
    seat.bet = stake;
    seat.balance = opened.balance;
    seat.sitOuts = 0;
  }

  async #refreshBalance(seat: Seat): Promise<void> {
    try {
      seat.balance = await this.#context.wallet.balanceOf({
        guildId: this.guildId,
        userId: seat.userId,
      });
    } catch (error) {
      this.#log.warn(
        { err: loggableError(error), userId: seat.userId },
        'could not read a balance',
      );
    }
  }

  #openBetting(): void {
    if (this.#closedReason !== null) return;
    this.#step += 1;
    this.#schedule(settings.bettingSeconds, () => this.#closeBetting());
  }

  async #closeBettingIfAllBet(): Promise<void> {
    if (this.#seats.length > 0 && this.#seats.every((seat) => seat.roundId !== null)) {
      await this.#closeBetting();
    }
  }

  async #closeBetting(): Promise<void> {
    if (this.#closedReason !== null) return;
    this.#clearTimer();
    for (const seat of [...this.#seats]) {
      if (seat.roundId !== null) continue;
      seat.sitOuts += 1;
      if (seat.sitOuts >= settings.maxSitOuts) this.#removeSeat(seat);
    }
    if (this.#seats.length === 0) {
      await this.#closeTable('empty');
      return;
    }
    if (this.#seats.every((seat) => seat.roundId === null)) {
      this.#openBetting();
      return;
    }
    if (this.#shoe.reshuffleDue) this.#shoe.shuffle();
    const bets = this.#seats.flatMap((seat) =>
      seat.roundId === null ? [] : [{ id: seat.userId, bet: seat.stake }],
    );
    this.#round = new BlackjackRound(rules, this.#shoe, bets);
    this.#timerKey = null;
    this.#last = null;
    await this.#afterRoundChange();
  }

  async #afterRoundChange(): Promise<void> {
    const round = this.#round;
    if (round === null || this.#closedReason !== null) return;
    if (round.phase === 'settled') {
      await this.#settle(round);
      return;
    }
    const { turn } = round;
    const key = turn === null ? round.phase : `${turn.seatId}:${turn.hand}`;
    if (key === this.#timerKey) return;
    this.#timerKey = key;
    this.#step += 1;
    if (round.phase === 'insurance') {
      this.#schedule(settings.insuranceSeconds, () => this.#insuranceTimeUp());
    } else {
      this.#schedule(settings.turnSeconds, () => this.#turnTimeUp());
    }
  }

  async #insuranceTimeUp(): Promise<void> {
    const round = this.#round;
    if (round?.phase !== 'insurance') return;
    round.closeInsurance();
    await this.#afterRoundChange();
  }

  async #turnTimeUp(): Promise<void> {
    const round = this.#round;
    const turn = round?.turn ?? null;
    if (round === null || turn === null) return;
    round.standRemaining(turn.seatId);
    await this.#afterRoundChange();
  }

  /** Settle, then show (SPEC §4): callers render the revealed hole card only after this. */
  async #settle(round: BlackjackRound): Promise<void> {
    this.#clearTimer();
    const tableRoundId = this.#tableRoundId;
    if (tableRoundId === null) throw new Error(`blackjack table ${this.id} dealt without bets`);
    const result = round.result();
    const players = result.seats.map((seatResult) => {
      const seat = this.#seatIn(seatResult.id);
      if (seat.roundId === null) throw new Error(`seat ${seat.userId} played without a round`);
      return { seat, roundId: seat.roundId, result: seatResult };
    });
    let settled: readonly SettledRound[] | null = null;
    try {
      settled = await this.#context.wallet.settleTableRound(
        tableRoundId,
        { dealer: result.dealer },
        players.map(({ roundId, result: seatResult }) => ({
          roundId,
          payout: seatResult.payout,
          details: seatResult,
        })),
      );
    } catch (error) {
      this.#log.error(
        { err: loggableError(error), tableRoundId },
        'could not settle a blackjack round',
      );
    }
    // It may say the round was settled after all, when only the answer got lost (finding 8).
    const refund =
      settled === null ? await this.#context.refunds.refund(tableRoundId, this.#log) : null;
    const balances = new Map((settled ?? []).map((row) => [row.userId, row.balance]));
    const view = round.view();
    this.#last =
      settled === null
        ? null
        : {
            view,
            last: true,
            players: players.map(({ seat, result: seatResult }) => ({
              id: seat.userId,
              number: seat.number,
              name: seat.name,
              net: seatResult.payout - seatResult.staked,
              balance: balances.get(seat.userId) ?? null,
            })),
          };
    for (const { seat } of players) {
      seat.balance = balances.get(seat.userId) ?? seat.balance;
      seat.roundId = null;
      seat.stake = 0;
      if (seat.leaving) this.#removeSeat(seat);
    }
    this.#round = null;
    this.#tableRoundId = null;
    this.#timerKey = null;
    // A pending refund keeps the players' rounds open, so they couldn't bet here anyway (R3).
    if (refund !== null) {
      this.#refund = refund;
      await this.#closeTable('settleFailed');
    } else if (this.#seats.length === 0) {
      await this.#closeTable('empty');
    } else {
      this.#openBetting();
    }
  }

  /** Ends the game, and hands the table back to its lobby, or closes it once it is lost. */
  async #closeTable(reason: ClosedReason): Promise<void> {
    if (await this.#stop(reason)) this.#host?.end(this, reason === 'lost' ? 'lost' : 'over');
  }

  /**
   * Stops the game and frees its seats; false when it had stopped already. An open table round
   * left here gets no settlement any more, so it is refunded.
   */
  async #stop(reason: ClosedReason): Promise<boolean> {
    if (this.#closedReason !== null) return false;
    this.#closedReason = reason;
    this.#clearTimer();
    this.#step += 1;
    this.#collector?.stop('closed');
    this.#context.tables.remove(this);
    // remove() only frees the seats of a registered table; an opening one has its opener's.
    for (const seat of this.#seats) this.#context.tables.unseat(this, seat.userId);
    const tableRoundId = this.#tableRoundId;
    this.#tableRoundId = null;
    if (tableRoundId !== null) await this.#context.refunds.refund(tableRoundId, this.#log);
    return true;
  }

  /** Opening failed after the opener's bet: refunded, and the table goes as if it never opened. */
  async #abandon(opened: TableHost | null): Promise<void> {
    await this.#stop('lost');
    if (opened === null) {
      this.#host?.end(this, 'over');
      return;
    }
    try {
      await opened.close();
    } catch (error) {
      this.#log.warn({ err: loggableError(error) }, 'could not close a table that failed to open');
    }
  }

  #schedule(seconds: number, task: () => Promise<void>): void {
    this.#clearTimer();
    if (this.#closedReason !== null) return;
    const token = this.#timerToken;
    this.#deadline = this.#context.clock().add({ seconds });
    this.#timer = setTimeout(() => {
      void this.#queue
        .run(async () => {
          if (token !== this.#timerToken || this.#closedReason !== null) return;
          await task();
          await this.#edit();
        })
        .catch((error: unknown) => {
          this.#log.error({ err: loggableError(error) }, 'a blackjack table timer failed');
        });
    }, seconds * 1000);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerToken += 1;
    this.#deadline = null;
  }

  #seatOf(userId: string): Seat | undefined {
    return this.#seats.find((seat) => seat.userId === userId);
  }

  #seatIn(userId: string): Seat {
    const seat = this.#seatOf(userId);
    if (seat === undefined) throw new Error(`user ${userId} has no seat at table ${this.id}`);
    return seat;
  }

  #freeSeatNumber(): number {
    let number = 1;
    while (this.#seats.some((seat) => seat.number === number)) number += 1;
    return number;
  }

  #newSeat(player: PlayerIdentity, bet: number, balance: number): Seat {
    return {
      number: this.#freeSeatNumber(),
      userId: player.userId,
      name: player.displayName,
      bet,
      balance,
      sitOuts: 0,
      leaving: false,
      roundId: null,
      stake: 0,
    };
  }

  #addSeat(seat: Seat): void {
    this.#seats.push(seat);
    this.#seats.sort((a, b) => a.number - b.number);
    this.#context.tables.seat(this, seat.userId);
  }

  #removeSeat(seat: Seat): void {
    const index = this.#seats.indexOf(seat);
    if (index >= 0) this.#seats.splice(index, 1);
    this.#context.tables.unseat(this, seat.userId);
  }

  #seated(seat: Seat, bet: number, placed: boolean): SeatedReply {
    return { seat: seat.number, bet, placed, url: this.#message?.url ?? '' };
  }

  /** Shows the table through the interaction; when that fails, through an edit of the message. */
  async #respond(interaction: Press | BetModal): Promise<void> {
    try {
      if (interaction.isButton()) {
        await interaction.update(this.#render());
        return;
      }
      // Bet forms are deferred as they arrive; on a form from a button that edits its message.
      if (interaction.deferred) {
        await interaction.editReply(this.#render());
        return;
      }
    } catch (error) {
      this.#log.warn(
        { ...interactionContext(interaction), err: loggableError(error) },
        'could not update the blackjack table',
      );
    }
    await this.#edit();
  }

  /** A failed edit is how the table learns that its message or thread is gone (finding 1). */
  async #edit(): Promise<void> {
    const message = this.#message;
    if (message === null || this.#closedReason === 'lost') return;
    try {
      await message.edit(this.#render());
    } catch (error) {
      if (isLostTableError(error)) {
        await this.#lost('edit', error);
        return;
      }
      this.#log.warn({ err: loggableError(error) }, 'could not edit the blackjack table');
    }
  }

  #listen(message: Message<true>): void {
    this.#message = message;
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
    });
    collector.on('collect', (press) => {
      this.#onCollect(press);
    });
    collector.on('end', (_presses, reason) => {
      this.#onEnd(reason);
    });
    this.#collector = collector;
  }

  #render(): TableMessage {
    return blackjackTableMessage(this.#locale, this.#snapshot());
  }

  #snapshot(): TableSnapshot {
    const round = this.#round;
    const view = round?.view() ?? null;
    const step = this.#step;
    return {
      tableNumber: this.#host?.number ?? 0,
      phase: this.#phase(view),
      closedReason: this.#closedReason,
      deadline: this.#deadline,
      seats: this.#seats.map((seat) => this.#seatLine(seat)),
      round: view === null ? this.#last : { view, players: this.#players(view), last: false },
      refund: this.#refund,
      cardsLeft: this.#shoe.cardsLeft,
      turnButtons: round === null || view === null ? [] : this.#turnButtons(round, view),
      customId: (action) => `${PREFIX}:${this.id}:${action}:${step}`,
    };
  }

  #phase(view: RoundView | null): TablePhase {
    if (this.#closedReason !== null) return 'closed';
    if (view === null) return 'betting';
    return view.phase === 'insurance' ? 'insurance' : 'turns';
  }

  #seatLine(seat: Seat): SeatLine {
    const line = { number: seat.number, name: seat.name, sitOuts: seat.sitOuts };
    if (this.#round === null) {
      if (seat.roundId !== null) {
        return { ...line, bet: seat.stake, status: seat.leaving ? 'leaving' : 'betPlaced' };
      }
      return { ...line, bet: seat.bet, status: seat.sitOuts > 0 ? 'noBetSatOut' : 'noBet' };
    }
    if (seat.roundId !== null) {
      return { ...line, bet: seat.stake, status: seat.leaving ? 'playingLeaving' : 'playing' };
    }
    return { ...line, bet: seat.bet, status: seat.sitOuts > 0 ? 'sittingOut' : 'nextRound' };
  }

  #players(view: RoundView): RoundPlayer[] {
    return view.seats.map((seatView) => {
      const seat = this.#seatOf(seatView.id);
      return {
        id: seatView.id,
        number: seat?.number ?? 0,
        name: seat?.name ?? '',
        net: null,
        balance: null,
      };
    });
  }

  #turnButtons(round: BlackjackRound, view: RoundView): TurnButton[] {
    const { turn } = view;
    if (turn === null) return [];
    const balance = this.#seatOf(turn.seatId)?.balance ?? null;
    const hand = view.seats.find((seat) => seat.id === turn.seatId)?.hands[turn.hand];
    const options = round.actions();
    return TURN_ACTIONS.map((action) => {
      const option = options.find((candidate) => candidate.action === action);
      const raises = action === 'double' || action === 'split';
      const cost = option?.cost ?? (raises ? (hand?.bet ?? 0) : 0);
      const affordable = balance === null || cost <= balance;
      return { action, cost, enabled: option !== undefined && affordable };
    });
  }
}

interface InteractionChannel {
  readonly channelId: string;
  readonly channel: GuildTextBasedChannel | null;
}

/** A modal's channel ID is typed nullable, but every interaction in a server has one. */
function channelOf(interaction: PlayInteraction): InteractionChannel {
  const { channelId, channel } = interaction;
  if (channelId === null) throw new Error(`interaction ${interaction.id} has no channel`);
  return { channelId, channel };
}

/** The registry keeps table threads as HostedTables; every one it holds is a TableHost. */
function isTableHost(host: HostedTable | undefined): host is TableHost {
  return host !== undefined && 'begin' in host && 'game' in host;
}

/** Inside a table thread: its blackjack game, or a new one when the table is between games. */
async function seatAtHost(
  host: TableHost,
  interaction: PlayInteraction,
  context: AppContext,
  stake: number,
  balance: number,
): Promise<Seating> {
  const { game } = host;
  const player = playerOf(interaction);
  if (game === null) {
    return BlackjackTable.open({
      context,
      locale: interaction.guildLocale,
      at: { host },
      player,
      stake,
      balance,
    });
  }
  const values = { number: host.number, command: 'blackjack' };
  if (!(game instanceof BlackjackTable)) {
    const name = t(interaction.locale, `tables.games.${game.game}`);
    throw new PlayerError('tables.errors.otherGame', { ...values, game: name });
  }
  const seated = game.hasRoom() ? await game.join(player, stake, balance) : null;
  if (seated === null) throw new PlayerError('tables.errors.full', values);
  return { table: game, seated };
}

/** SPEC §4 seating, inside the server's seating queue, so two players can't both open a table. */
async function takeSeat(
  interaction: PlayInteraction,
  context: AppContext,
  stake: number,
  balance: number,
): Promise<Seating> {
  const { tables } = context;
  const player = playerOf(interaction);
  const own = tables.tableOf('blackjack', player.guildId, player.userId);
  if (own instanceof BlackjackTable) {
    const seated = await own.changeBet(player, stake);
    if (seated !== null) return { table: own, seated };
  }
  if (stake > balance) {
    throw new PlayerError('errors.insufficientFunds', {
      needed: formatCoins(stake),
      balance: formatCoins(balance),
    });
  }
  const channel = channelOf(interaction);
  const host = tables.hostIn(player.guildId, channel.channelId);
  if (isTableHost(host) && !host.closed) {
    return seatAtHost(host, interaction, context, stake, balance);
  }
  const free = tables.tableWithRoom(
    'blackjack',
    player.guildId,
    seatingChannelId(channel),
    channelsVisibleTo(interaction),
  );
  if (free instanceof BlackjackTable) {
    const seated = await free.join(player, stake, balance);
    if (seated !== null) return { table: free, seated };
  }
  const missing = missingTablePermissions(interaction);
  if (missing.length > 0) {
    throw new PlayerError(...missingPermissionsMessage(interaction.locale, missing));
  }
  return BlackjackTable.open({
    context,
    locale: interaction.guildLocale,
    at: { parent: tableParentOf(channel) },
    player,
    stake,
    balance,
  });
}

/**
 * /blackjack and the lobby's bet form (SPEC §7): seats the player with this bet and confirms it
 * with a link to the table message. A PlayerError is thrown to the caller, who shows it.
 */
export async function playBlackjack(
  interaction: PlayInteraction,
  betText: string,
  context: AppContext,
): Promise<void> {
  // Before the first database call, so the 3 seconds can't run out (finding 10).
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const balance = await context.wallet.balanceOf(playerOf(interaction));
  const stake = parseStake(betText, balance);
  const { table, seated } = await context.tables.inGuild(interaction.guildId, () =>
    takeSeat(interaction, context, stake, balance),
  );
  const elsewhere = table.channelId !== seatingChannelId(channelOf(interaction));
  try {
    await interaction.editReply({
      content: blackjackSeatReply(interaction.locale, seated, elsewhere),
    });
  } catch (error) {
    context.logger.warn(
      { ...interactionContext(interaction), err: loggableError(error) },
      'could not confirm a blackjack seat',
    );
  }
}
