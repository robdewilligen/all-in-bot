import { randomInt } from 'node:crypto';
import {
  MessageFlags,
  type EmbedBuilder,
  type GuildTextBasedChannel,
  type MessageEditOptions,
} from 'discord.js';
import { gameConfig } from '../../config/game.js';
import { stakeLimitError } from '../../core/amount.js';
import { PlayerError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { RoundSettlement, SettledRound, Wallet } from '../../core/wallet.js';
import {
  parseBets,
  settle,
  spin,
  type RouletteBet,
  type SettledBet,
} from '../../games/roulette/index.js';
import { formatCoins } from '../../i18n/format.js';
import { t } from '../../i18n/index.js';
import {
  rouletteBetsEmbed,
  rouletteBettingEmbed,
  rouletteCancelledEmbed,
  rouletteClosedEmbed,
  roulettePlayerResultEmbed,
  rouletteResultEmbed,
  rouletteRollingEmbed,
  type BetsSoFar,
  type SeatView,
} from '../../ui/roulette.js';
import { missingPermissionsMessage, missingTablePermissions } from '../channel-permissions.js';
import { interactionContext, loggableError } from '../errors.js';
import { playerOf } from '../player.js';
import type { AppContext } from '../types.js';
import type { RefundResult, TableRefunds } from './refunds.js';
import { ActionQueue, type HostedTable, type LiveTable, type TableRegistry } from './registry.js';
import type { PlayInteraction, TableHost } from './table.js';
import {
  channelsVisibleTo,
  isLostTableError,
  seatingChannelId,
  tableParentOf,
  type TableParent,
} from './thread.js';

/** Returns a whole number from 0 to max - 1. */
export type Draw = (max: number) => number;

const cryptoDraw: Draw = (max) => randomInt(max);

/** What a roulette game runs on: the app's services, and in tests a draw of their own. */
export interface RouletteContext extends AppContext {
  /** The spin's draw: crypto.randomInt unless a test passes its own. */
  readonly draw?: Draw;
}

export interface RouletteEntry {
  /** Deferred or replied to already, so the player's result can follow up on it. */
  readonly interaction: PlayInteraction;
  readonly bets: readonly RouletteBet[];
}

/** The player's bets at their table after a /roulette, for their confirmation. */
export interface Placement extends BetsSoFar {
  /** The channel the table's thread is in. */
  readonly channelId: string;
}

interface Totals {
  readonly stake: number;
  readonly count: number;
}

interface Seat {
  readonly userId: string;
  readonly roundId: number;
  readonly bets: RouletteBet[];
  stake: number;
  count: number;
  name: string;
  /** The player's latest /roulette or bet form, which gets their result. */
  interaction: PlayInteraction;
}

interface SettledSeat {
  readonly seat: Seat;
  readonly bets: SettledBet[];
  readonly payout: number;
}

interface Outcome {
  readonly result: number;
  readonly seats: readonly SettledSeat[];
  readonly rounds: readonly SettledRound[];
}

interface TableMessage {
  readonly url: string;
  edit(options: MessageEditOptions): Promise<unknown>;
}

/** Where a new game starts: at a table in its lobby, or at a table that opens for it. */
type Venue = { readonly lobby: TableHost } | { readonly parent: TableParent };

type Phase = 'betting' | 'spinning' | 'revealing' | 'closed';

const NO_BETS: Totals = { stake: 0, count: 0 };

function totalsOf(bets: readonly RouletteBet[]): Totals {
  return {
    stake: bets.reduce((sum, bet) => sum + bet.amount, 0),
    count: bets.reduce((sum, bet) => sum + bet.countsAs, 0),
  };
}

/** The per-spin limits of one player (SPEC §4): a number of bets, and a total within the stakes. */
function checkLimits(placed: Totals, adding: Totals): void {
  const { roulette, stakes } = gameConfig;
  if (placed.count + adding.count > roulette.maxBetsPerSpin) {
    throw new PlayerError('roulette.errors.tooManyBets', {
      placed: placed.count,
      max: roulette.maxBetsPerSpin,
      count: adding.count,
    });
  }
  const total = placed.stake + adding.stake;
  if (placed.stake > 0 && total > stakes.max) {
    throw new PlayerError('roulette.errors.aboveMaximum', {
      total: formatCoins(total),
      max: formatCoins(stakes.max),
      placed: formatCoins(placed.stake),
    });
  }
  const outside = stakeLimitError(total, stakes);
  if (outside !== null) throw new PlayerError(...outside);
}

interface PlayChannel {
  readonly channelId: string;
  readonly channel: GuildTextBasedChannel | null;
}

/** Where the player is. Discord types a form's channel as optional; a lobby's form has one. */
function channelOf({ id, channelId, channel }: PlayInteraction): PlayChannel {
  if (channelId === null) throw new Error(`interaction ${id} has no channel`);
  return { channelId, channel };
}

/** The channel a new table's thread opens in; a PlayerError when the bot can't open one there. */
function newTableParent(interaction: PlayInteraction): TableParent {
  const missing = missingTablePermissions(interaction);
  if (missing.length > 0) {
    throw new PlayerError(...missingPermissionsMessage(interaction.locale, missing));
  }
  return tableParentOf(channelOf(interaction));
}

/**
 * A roulette game at a table (SPEC §4 and §6). Players bet until the countdown ends; then one spin
 * settles every player in one transaction, the message reveals the result and the game is over.
 * Bets, the spin and closing run through the game's queue, one at a time.
 */
export class RouletteTable implements LiveTable {
  readonly game = 'roulette';
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;

  readonly #wallet: Wallet;
  readonly #tables: TableRegistry;
  readonly #refunds: TableRefunds;
  readonly #logger: Logger;
  readonly #clock: () => Temporal.Instant;
  readonly #draw: Draw;
  readonly #tableRoundId: number;
  readonly #locale: string;
  readonly #log: {
    readonly guildId: string;
    readonly tableId: string;
    readonly tableRoundId: number;
  };
  readonly #queue = new ActionQueue();
  readonly #seats = new Map<string, Seat>();
  readonly #spinsAt: Temporal.Instant;
  #phase: Phase = 'betting';
  #host: TableHost | undefined;
  #message: TableMessage | undefined;
  /** Its message or thread is gone, so nobody else sits down; the spin still runs. */
  #lost = false;
  #countdown: ReturnType<typeof setTimeout> | undefined;
  #edits: Promise<void> = Promise.resolve();
  #latest: EmbedBuilder | undefined;
  #shown: EmbedBuilder | undefined;
  #revealing: Promise<void> = Promise.resolve();
  #closing = false;
  #delay: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;

  private constructor(
    context: RouletteContext,
    interaction: PlayInteraction,
    tableRoundId: number,
    channelId: string,
  ) {
    this.#wallet = context.wallet;
    this.#tables = context.tables;
    this.#refunds = context.refunds;
    this.#logger = context.logger;
    this.#clock = context.clock;
    this.#draw = context.draw ?? cryptoDraw;
    this.id = context.tables.newTableId();
    this.guildId = interaction.guildId;
    this.channelId = channelId;
    this.#tableRoundId = tableRoundId;
    this.#locale = interaction.guildLocale;
    this.#log = { guildId: this.guildId, tableId: this.id, tableRoundId };
    this.#spinsAt = this.#clock().add({ seconds: gameConfig.roulette.bettingSeconds });
  }

  /**
   * Starts a game with the player's first bets: at the lobby's table, or (lobby null) at a new
   * table whose thread opens in the player's channel. Money first: the bets are debited before a
   * thread opens or a lobby changes. When anything after that fails, the table round is refunded,
   * a new table closes and a lobby shows again.
   */
  static async open(
    entry: RouletteEntry,
    context: RouletteContext,
    lobby: TableHost | null,
  ): Promise<Placement> {
    const { interaction, bets } = entry;
    checkLimits(NO_BETS, totalsOf(bets));
    const venue: Venue = lobby === null ? { parent: newTableParent(interaction) } : { lobby };
    const channelId = 'lobby' in venue ? venue.lobby.channelId : venue.parent.id;
    const tableRoundId = await context.wallet.openTableRound(interaction.guildId, 'roulette');
    const table = new RouletteTable(context, interaction, tableRoundId, channelId);
    let host: TableHost | undefined;
    let seat: Seat;
    try {
      seat = await table.#addBets(entry);
      host =
        'lobby' in venue
          ? venue.lobby
          : await context.hosts.open({
              context,
              parent: venue.parent,
              game: 'roulette',
              locale: interaction.guildLocale,
              userId: interaction.user.id,
            });
      host.begin(table);
      table.#host = host;
      host.addPlayer(interaction.user.id);
      table.#message = await host.send({ embeds: [table.#bettingEmbed()] });
    } catch (error) {
      await table.#abandon(host, 'lobby' in venue, error);
      throw error;
    }
    context.tables.add(table);
    table.#startCountdown();
    return table.#placement(seat);
  }

  hasRoom(): boolean {
    return (
      this.#phase === 'betting' && !this.#lost && this.#seats.size < gameConfig.roulette.maxPlayers
    );
  }

  /**
   * Adds the player's bets to the coming spin. A PlayerError when betting closed, when there is no
   * seat for a new player, or when a limit is hit.
   */
  placeBets(entry: RouletteEntry): Promise<Placement> {
    return this.#queue.run(async () => {
      if (this.#phase !== 'betting') throw new PlayerError('roulette.errors.bettingClosed');
      if (!this.#seats.has(entry.interaction.user.id) && !this.hasRoom()) {
        if (this.#lost || this.#host === undefined) {
          throw new PlayerError('roulette.errors.bettingClosed');
        }
        throw new PlayerError('tables.errors.full', {
          number: this.#host.number,
          command: 'roulette',
        });
      }
      const seat = await this.#addBets(entry);
      void this.#show(this.#bettingEmbed());
      return this.#placement(seat);
    });
  }

  /**
   * Shutdown: an unsettled game stops and says so, and the startup refund returns its stakes. A
   * spin that is already settled shows its result at once. The registry closes the table next.
   */
  async close(): Promise<void> {
    clearTimeout(this.#countdown);
    this.#closing = true;
    clearTimeout(this.#delay);
    this.#wake?.();
    await this.#queue.run(() => {
      if (this.#phase === 'betting') {
        this.#phase = 'closed';
        void this.#show(rouletteClosedEmbed(this.#locale, this.#seatViews()));
      }
      return Promise.resolve();
    });
    await this.#revealing;
    await this.#edits;
  }

  /** Money first: the wallet throws a PlayerError when coins are short, and nothing changes then. */
  async #addBets({ interaction, bets }: RouletteEntry): Promise<Seat> {
    const userId = interaction.user.id;
    const adding = totalsOf(bets);
    let seat = this.#seats.get(userId);
    checkLimits(seat ?? NO_BETS, adding);
    if (seat === undefined) {
      const player = playerOf(interaction);
      const opened = await this.#wallet.openRound(player, this.#tableRoundId, adding.stake);
      seat = {
        userId,
        roundId: opened.roundId,
        bets: [],
        stake: opened.stake,
        count: 0,
        name: player.displayName,
        interaction,
      };
      this.#seats.set(userId, seat);
      this.#tables.seat(this, userId);
      this.#host?.addPlayer(userId);
    } else {
      seat.stake = (await this.#wallet.raiseRound(seat.roundId, adding.stake)).stake;
    }
    seat.bets.push(...bets);
    seat.count += adding.count;
    seat.name = interaction.member.displayName;
    seat.interaction = interaction;
    return seat;
  }

  /** A start that failed after the debit: the stakes go back and the table is left as it was. */
  async #abandon(host: TableHost | undefined, atLobby: boolean, error: unknown): Promise<void> {
    this.#phase = 'closed';
    for (const userId of this.#seats.keys()) this.#tables.unseat(this, userId);
    await this.#refund();
    if (host === undefined) return;
    if (atLobby) {
      host.end(this, isLostTableError(error) ? 'lost' : 'over');
      return;
    }
    try {
      await host.close();
    } catch (closeError) {
      this.#logger.warn(
        { ...this.#log, err: loggableError(closeError) },
        'could not close a roulette table that failed to open',
      );
    }
  }

  #placement(seat: Seat): Placement {
    if (this.#message === undefined) throw new Error(`table ${this.id} has no message yet`);
    return {
      bets: [...seat.bets],
      stake: seat.stake,
      count: seat.count,
      spinsAt: this.#spinsAt,
      url: this.#message.url,
      channelId: this.channelId,
    };
  }

  #seatViews(): SeatView[] {
    return [...this.#seats.values()].map((seat) => ({
      name: seat.name,
      stake: seat.stake,
      bets: seat.count,
    }));
  }

  #bettingEmbed(): EmbedBuilder {
    return rouletteBettingEmbed(
      this.#locale,
      this.#seatViews(),
      gameConfig.roulette.maxPlayers,
      this.#spinsAt,
    );
  }

  /** Edits run one after another, and an edit that a newer one replaced before it ran is skipped. */
  #show(embed: EmbedBuilder): Promise<void> {
    this.#latest = embed;
    this.#edits = this.#edits.then(() => this.#editToLatest());
    return this.#edits;
  }

  async #editToLatest(): Promise<void> {
    const embed = this.#latest;
    if (embed === undefined || embed === this.#shown || this.#message === undefined) return;
    if (this.#lost) return;
    this.#shown = embed;
    try {
      await this.#message.edit({ embeds: [embed] });
    } catch (error) {
      if (isLostTableError(error)) this.#lost = true;
      this.#logger.warn(
        { ...this.#log, lost: this.#lost, err: loggableError(error) },
        'could not edit a roulette table',
      );
    }
  }

  #startCountdown(): void {
    const wait = this.#spinsAt.epochMilliseconds - this.#clock().epochMilliseconds;
    this.#countdown = setTimeout(
      () => {
        this.#queue
          .run(() => this.#spin())
          .catch((error: unknown) => {
            this.#logger.error(
              { ...this.#log, err: loggableError(error) },
              'a roulette spin failed',
            );
          });
      },
      Math.max(0, wait),
    );
  }

  async #spin(): Promise<void> {
    if (this.#phase !== 'betting') return;
    this.#phase = 'spinning';
    let outcome: Outcome;
    try {
      outcome = await this.#settle();
    } catch (error) {
      this.#logger.error(
        { ...this.#log, err: loggableError(error) },
        'could not settle a roulette spin',
      );
      const refund = await this.#refund();
      this.#leave();
      await this.#show(rouletteCancelledEmbed(this.#locale, refund, this.#seatViews()));
      this.#end();
      return;
    }
    this.#phase = 'revealing';
    this.#revealing = this.#reveal(outcome);
  }

  async #settle(): Promise<Outcome> {
    const result = spin(this.#draw);
    const seats = [...this.#seats.values()].map((seat): SettledSeat => {
      const bets = settle(seat.bets, result);
      return { seat, bets, payout: bets.reduce((sum, bet) => sum + bet.payout, 0) };
    });
    const settlements = seats.map(({ seat, bets, payout }): RoundSettlement => ({
      roundId: seat.roundId,
      payout,
      details: bets.map((settled) => ({
        bet: settled.bet.label,
        amount: settled.bet.amount,
        payout: settled.payout,
      })),
    }));
    // Settled in the database before anything shows the result (SPEC §4).
    const rounds = await this.#wallet.settleTableRound(
      this.#tableRoundId,
      { number: result },
      settlements,
    );
    return { result, seats, rounds };
  }

  async #reveal({ result, seats, rounds }: Outcome): Promise<void> {
    try {
      await this.#show(rouletteRollingEmbed(this.#locale, this.#seatViews()));
      await this.#pause(gameConfig.roulette.revealDelayMs);
      const balances = new Map(rounds.map((round) => [round.roundId, round.balance]));
      const players = seats.map(({ seat, payout }) => ({
        name: seat.name,
        stake: seat.stake,
        payout,
      }));
      await Promise.all([
        this.#show(rouletteResultEmbed(this.#locale, result, players)),
        ...seats.map((settled) =>
          this.#sendResult(settled, result, balances.get(settled.seat.roundId)),
        ),
      ]);
    } catch (error) {
      this.#logger.error(
        { ...this.#log, err: loggableError(error) },
        'could not reveal a roulette spin',
      );
    } finally {
      this.#leave();
      this.#end();
    }
  }

  async #sendResult(
    { seat, bets, payout }: SettledSeat,
    result: number,
    balance: number | undefined,
  ): Promise<void> {
    const { interaction } = seat;
    try {
      if (balance === undefined) throw new Error(`round ${seat.roundId} has no settled balance`);
      const embed = roulettePlayerResultEmbed(interaction.locale, {
        result,
        bets,
        stake: seat.stake,
        payout,
        balance,
      });
      await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.#logger.warn(
        { ...this.#log, userId: seat.userId, err: loggableError(error) },
        'could not send a roulette result',
      );
    }
  }

  /** The reveal's pause; close() cuts it short. */
  #pause(ms: number): Promise<void> {
    if (this.#closing) return Promise.resolve();
    return new Promise((resolve) => {
      this.#wake = resolve;
      this.#delay = setTimeout(resolve, ms);
    });
  }

  /** Never rejects: a refund the database refuses is retried in the background (SPEC §10). */
  #refund(): Promise<RefundResult> {
    return this.#refunds.refund(this.#tableRoundId, this.#logger);
  }

  /** The spin is done: its players are free to play again, at this table or another. */
  #leave(): void {
    this.#phase = 'closed';
    for (const userId of this.#seats.keys()) this.#tables.unseat(this, userId);
    this.#tables.remove(this);
  }

  /** The table shows its lobby again, or closes when it was lost. At shutdown the registry closes it. */
  #end(): void {
    if (this.#closing) return;
    this.#host?.end(this, this.#lost ? 'lost' : 'over');
  }
}

function asRoulette(table: LiveTable): RouletteTable {
  if (!(table instanceof RouletteTable))
    throw new Error(`table ${table.id} is not a roulette table`);
  return table;
}

/** The registry holds TableHosts, typed as the HostedTable it needs. */
function isTableHost(host: HostedTable): host is TableHost {
  return 'begin' in host;
}

/** The live table whose thread the player is in, if it is one. */
function hostIn(tables: TableRegistry, guildId: string, where: PlayChannel): TableHost | undefined {
  const host = tables.hostIn(guildId, where.channelId);
  return host !== undefined && isTableHost(host) && !host.closed ? host : undefined;
}

/** In a table's thread: join its roulette game, or start one in its lobby. */
function playAt(
  host: TableHost,
  entry: RouletteEntry,
  context: RouletteContext,
): Promise<Placement> {
  const { game } = host;
  if (game === null) return RouletteTable.open(entry, context, host);
  if (game.game !== 'roulette') {
    throw new PlayerError('tables.errors.otherGame', {
      number: host.number,
      game: t(entry.interaction.locale, `tables.games.${game.game}`),
      command: 'roulette',
    });
  }
  return asRoulette(game).placeBets(entry);
}

/**
 * Seats the player by SPEC §4 and places their bets: at their own game this spin, then at the
 * table whose thread they are in, then at a game with room (this channel first, then one they can
 * see), otherwise at a new table in this channel. Seating runs one command at a time per server,
 * so two commands can't both open a table or take the last seat; once shutdown has begun the
 * registry refuses it.
 */
export function placeRouletteBets(
  entry: RouletteEntry,
  context: RouletteContext,
): Promise<Placement> {
  const { interaction } = entry;
  const { tables } = context;
  const { guildId } = interaction;
  return tables.inGuild(guildId, async () => {
    const own = tables.tableOf('roulette', guildId, interaction.user.id);
    if (own !== undefined) return asRoulette(own).placeBets(entry);
    const where = channelOf(interaction);
    const host = hostIn(tables, guildId, where);
    if (host !== undefined) return playAt(host, entry, context);
    const table = tables.tableWithRoom(
      'roulette',
      guildId,
      seatingChannelId(where),
      channelsVisibleTo(interaction),
    );
    if (table !== undefined) return asRoulette(table).placeBets(entry);
    return RouletteTable.open(entry, context, null);
  });
}

/**
 * /roulette and the lobby's bet form (SPEC §6): places the player's bets and confirms them
 * privately, with a link to the table message. A PlayerError goes to the caller to show.
 */
export async function playRoulette(
  interaction: PlayInteraction,
  betsText: string,
  context: RouletteContext,
): Promise<void> {
  // Seating can wait for other players' bets or a spin being settled; this keeps Discord's 3 seconds.
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  const balance = await context.wallet.balanceOf(playerOf(interaction));
  const parsed = parseBets(
    betsText,
    { balance, max: gameConfig.stakes.max },
    gameConfig.roulette.maxBetsPerSpin,
  );
  if (!parsed.ok) throw new PlayerError(...parsed.error);
  const placement = await placeRouletteBets({ interaction, bets: parsed.bets }, context);
  try {
    const elsewhere = placement.channelId !== seatingChannelId(channelOf(interaction));
    await interaction.editReply({
      embeds: [rouletteBetsEmbed(interaction.locale, placement, elsewhere)],
    });
  } catch (error) {
    // The bets stand; the table message shows them.
    context.logger.error(
      { ...interactionContext(interaction), err: loggableError(error) },
      'could not confirm roulette bets',
    );
  }
}
