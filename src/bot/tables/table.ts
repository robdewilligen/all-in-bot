import {
  ComponentType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionCollector,
  type Message,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
} from 'discord.js';
import { gameConfig } from '../../config/game.js';
import { PlayerError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { TableNumbers } from '../../core/table-numbers.js';
import type { TableGame } from '../../core/wallet.js';
import { t } from '../../i18n/index.js';
import {
  betForm,
  FORM_FIELDS,
  isLobbyAction,
  lobbyMessage,
  threadName,
  type LobbyAction,
  type LobbyClosedReason,
  type LobbyMessage,
  type LobbyView,
} from '../../ui/table.js';
import { loggableError, replyEphemeral, replyWithError } from '../errors.js';
import { playerOf } from '../player.js';
import type { AppContext } from '../types.js';
import { playBlackjack } from './blackjack-table.js';
import { ActionQueue, HOST_PREFIX, type HostedTable, type LiveTable } from './registry.js';
import { playRoulette } from './roulette-table.js';
import {
  archiveTableThread,
  openTableThread,
  type TableParent,
  type TableThread,
} from './thread.js';

/** A command or a lobby bet form: both play a game the same way (SPEC §4). */
export type PlayInteraction =
  ChatInputCommandInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

/** `over` brings the table back to its lobby; `lost` closes it, because its thread or message is gone. */
export type GameEnd = 'over' | 'lost';

/**
 * A table: one public thread ("Table #12 (Roulette)") that hosts one game at a time (SPEC §4).
 * Between games it shows a lobby, where the players pick the next game or leave.
 */
export interface TableHost extends HostedTable {
  /** The server's table number, in the thread name. */
  readonly number: number;
  /** The channel the thread is in; seating compares it with the player's channel. */
  readonly channelId: string;
  /** A link to the thread. */
  readonly url: string;
  /** The game being played; null in the lobby and once the table closed. */
  readonly game: LiveTable | null;
  readonly closed: boolean;
  /** Posts in the thread, for instance a game's table message. */
  send(options: MessageCreateOptions): Promise<Message<true>>;
  /**
   * The lobby becomes this game, once its first bet is placed: the thread is renamed when the game
   * changed, and the lobby message loses its buttons. Throws while a game runs or once closed.
   */
  begin(game: LiveTable): void;
  /** The player bet at this table; the table closes once every player has left. */
  addPlayer(userId: string): void;
  /** A game calls this once, when it is done. Ignored for a game that isn't the current one. */
  end(game: LiveTable, reason: GameEnd): void;
}

export interface OpenHostOptions {
  readonly context: AppContext;
  readonly parent: TableParent;
  /**
   * Null for /create-table: the thread is named "Table #12" and shows the lobby. With a game, it is
   * named "Table #12 (Roulette)" and waits for that game's begin(); it shows a lobby once it ends.
   */
  readonly game: TableGame | null;
  /** The server's language: the thread name and the lobby are shared. */
  readonly locale: string;
  /** The creator, or the player whose bet opens the table: its first player. */
  readonly userId: string;
}

export interface TableHosts {
  /**
   * Takes the server's next table number, starts the thread and registers the table. Callers run
   * it inside `tables.inGuild`. When the thread can't be started it rejects and leaves nothing.
   */
  open(options: OpenHostOptions): Promise<TableHost>;
}

type Press = ButtonInteraction<'cached'>;
type Form = ModalSubmitInteraction<'cached'>;

const settings = gameConfig.tables;
const RENAME_WINDOW_MS = 10 * 60_000;
/** The reason this class stops its own collectors with; any other reason means the thread is gone. */
const DONE = 'done';

interface ParsedPress {
  readonly action: LobbyAction;
  readonly step: number;
}

function play(game: TableGame, form: Form, text: string, context: AppContext): Promise<void> {
  return game === 'roulette'
    ? playRoulette(form, text, context)
    : playBlackjack(form, text, context);
}

/**
 * A table thread (SPEC §4). Presses, lobby posts and edits run one at a time through its queue;
 * begin() and end() change the state at once and queue the message work.
 */
class ThreadTableHost implements TableHost {
  readonly id: string;
  readonly number: number;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly url: string;
  readonly #context: AppContext;
  readonly #thread: TableThread;
  readonly #locale: string;
  readonly #log: Logger;
  readonly #queue = new ActionQueue();
  readonly #players = new Set<string>();
  #game: LiveTable | null = null;
  #closedReason: LobbyClosedReason | null = null;
  /** The game in the thread's name; null for a plain "Table #12". */
  #named: TableGame | null;
  /** When the recent renames were asked for (epoch ms), for Discord's limit per 10 minutes. */
  #renames: number[] = [];
  /** The newest lobby message; null before the first one and after its game ended. */
  #lobby: Message<true> | null = null;
  #collector: InteractionCollector<Press> | null = null;
  #step = 0;
  #forms = 0;
  /** Forms nobody submitted in time; a late submit gets the "expired" notice from interactionCreate. */
  readonly #expiredForms = new Set<string>();
  #closesAt: Temporal.Instant | null = null;
  #timer: NodeJS.Timeout | undefined;
  #timerToken = 0;

  private constructor(options: OpenHostOptions, number: number, thread: TableThread) {
    this.#context = options.context;
    this.id = options.context.tables.newTableId();
    this.number = number;
    this.guildId = options.parent.guildId;
    this.channelId = options.parent.id;
    this.threadId = thread.id;
    this.url = thread.url;
    this.#thread = thread;
    this.#locale = options.locale;
    this.#named = options.game;
    this.#log = options.context.logger.child({
      guildId: this.guildId,
      channelId: this.channelId,
      threadId: this.threadId,
      tableId: this.id,
    });
  }

  static async open(numbers: TableNumbers, options: OpenHostOptions): Promise<ThreadTableHost> {
    const { context, parent, game, locale } = options;
    const number = await numbers.next(parent.guildId);
    const thread = await openTableThread(parent, threadName(locale, number, game));
    const host = new ThreadTableHost(options, number, thread);
    host.addPlayer(options.userId);
    context.tables.addHost(host);
    if (game !== null) {
      // In case its game never begins.
      host.#startIdleTimer();
      return host;
    }
    try {
      await host.#postLobby();
    } catch (error) {
      host.#markClosed('lost');
      await archiveTableThread(thread, host.#log);
      throw error;
    }
    return host;
  }

  get game(): LiveTable | null {
    return this.#game;
  }

  get closed(): boolean {
    return this.#closedReason !== null;
  }

  send(options: MessageCreateOptions): Promise<Message<true>> {
    return this.#thread.send(options);
  }

  answers(customId: string): boolean {
    return !this.#expiredForms.has(customId);
  }

  begin(game: LiveTable): void {
    // The table closed while the first bet was being placed; the game refunds that bet.
    if (this.closed) throw new PlayerError('errors.tableClosed');
    if (this.#game !== null) throw new Error(`table ${this.id} already plays ${this.#game.game}`);
    this.#game = game;
    this.#step += 1;
    this.#clearTimer();
    this.#rename(game.game);
    this.#queueWork(() => this.#refresh());
  }

  addPlayer(userId: string): void {
    if (!this.closed) this.#players.add(userId);
  }

  end(game: LiveTable, reason: GameEnd): void {
    if (this.closed || this.#game !== game) return;
    this.#game = null;
    if (reason === 'lost') {
      this.#closeLater('lost');
      return;
    }
    // At shutdown the registry closes this table right after its game: no new lobby.
    if (this.#context.tables.closing) return;
    // The old lobby message keeps saying which game it started; the next one goes at the bottom.
    this.#stopCollector();
    this.#lobby = null;
    this.#queueWork(() => this.#nextLobby());
  }

  /** Shutdown or cleanup; the game, if any, is closed by whoever calls this. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.#markClosed('restart');
    await this.#queue.run(() => this.#showClosed());
  }

  #queueWork(work: () => Promise<void>): void {
    void this.#queue.run(work).catch((error: unknown) => {
      this.#log.error({ err: loggableError(error) }, 'a table update failed');
    });
  }

  /** Runs inside the queue, or in open() before anyone can press. Throws when the post fails. */
  async #postLobby(): Promise<void> {
    this.#step += 1;
    if (this.#game === null) this.#startIdleTimer();
    const message = await this.#thread.send(this.#render());
    this.#lobby = message;
    this.#stopCollector();
    // Closed while the post was on its way: the queued closing edit still finds the message.
    if (this.closed) return;
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

  async #nextLobby(): Promise<void> {
    // A command in the thread may have started the next game already.
    if (this.closed || this.#game !== null) return;
    try {
      await this.#postLobby();
    } catch (error) {
      this.#log.warn({ err: loggableError(error) }, 'could not post a table lobby');
      this.#markClosed('lost');
      await archiveTableThread(this.#thread, this.#log);
    }
  }

  #onCollect(press: Press): void {
    void this.#queue
      .run(() => this.#onPress(press))
      .catch((error: unknown) => replyWithError(press, error, this.#log));
  }

  #onEnd(reason: string): void {
    if (reason === DONE) return;
    this.#log.warn({ reason }, 'a table lost its thread');
    this.#closeLater('lost');
  }

  #parse(customId: string): ParsedPress | null {
    const [prefix, hostId, action, step] = customId.split(':');
    if (prefix !== HOST_PREFIX || hostId !== this.id || step === undefined || !/^\d+$/.test(step)) {
      return null;
    }
    return action !== undefined && isLobbyAction(action) ? { action, step: Number(step) } : null;
  }

  async #onPress(press: Press): Promise<void> {
    const parsed = this.#parse(press.customId);
    if (this.closed || this.#game !== null || parsed?.step !== this.#step) {
      await press.deferUpdate();
      return;
    }
    if (parsed.action === 'leave') {
      await this.#leave(press);
      return;
    }
    await this.#showForm(press, parsed.action);
  }

  async #showForm(press: Press, game: TableGame): Promise<void> {
    this.#forms += 1;
    const customId = `${HOST_PREFIX}:${this.id}:form-${game}:${String(this.#forms)}`;
    await press.showModal(betForm(press.locale, game, customId));
    void this.#awaitForm(press, game, customId);
  }

  /** Waits outside the queue: a player may take a while to type, or never submit. */
  async #awaitForm(press: Press, game: TableGame, customId: string): Promise<void> {
    let form: Form;
    try {
      form = await press.awaitModalSubmit({
        filter: (candidate) =>
          candidate.user.id === press.user.id && candidate.customId === customId,
        time: settings.formSeconds * 1000,
      });
    } catch {
      this.#expiredForms.add(customId);
      return;
    }
    // interactionCreate answers the forms of a closed table.
    if (this.closed) return;
    try {
      // What interactionCreate does before a command: acknowledge, then refresh the player's row.
      await form.deferReply({ flags: MessageFlags.Ephemeral });
      await this.#context.wallet.touchPlayer(playerOf(form));
      await play(game, form, form.fields.getTextInputValue(FORM_FIELDS[game]), this.#context);
    } catch (error) {
      await replyWithError(form, error, this.#log);
    }
  }

  async #leave(press: Press): Promise<void> {
    if (!this.#players.delete(press.user.id)) {
      await replyEphemeral(press, t(press.locale, 'tables.notices.notAPlayer'));
      return;
    }
    if (this.#players.size > 0) {
      await this.#respond(press);
      return;
    }
    this.#markClosed('empty');
    await this.#respond(press);
    await archiveTableThread(this.#thread, this.#log);
  }

  #rename(game: TableGame): void {
    if (this.#named === game) return;
    const now = this.#context.clock().epochMilliseconds;
    this.#renames = this.#renames.filter((at) => now - at < RENAME_WINDOW_MS);
    if (this.#renames.length >= settings.renamesPerTenMinutes) {
      // Discord would hold the request back for minutes; the name catches up at the next change.
      this.#log.info({ game }, 'skipped a table rename to stay within the rename limit');
      return;
    }
    this.#renames.push(now);
    const previous = this.#named;
    this.#named = game;
    const name = threadName(this.#locale, this.number, game);
    void this.#thread
      .setName(name, 'The All-in table plays another game')
      .catch((error: unknown) => {
        this.#log.warn({ err: loggableError(error), name }, 'could not rename a table thread');
        if (this.#named === game) this.#named = previous;
      });
  }

  /** The closed state at once, so no press, form or timer acts on it any more. */
  #markClosed(reason: LobbyClosedReason): void {
    this.#closedReason = reason;
    this.#game = null;
    this.#step += 1;
    this.#clearTimer();
    this.#stopCollector();
    this.#context.tables.removeHost(this);
  }

  #closeLater(reason: LobbyClosedReason): void {
    if (this.closed) return;
    this.#markClosed(reason);
    this.#queueWork(() => this.#showClosed());
  }

  async #showClosed(): Promise<void> {
    await this.#refresh();
    await archiveTableThread(this.#thread, this.#log);
  }

  #startIdleTimer(): void {
    this.#clearTimer();
    const token = this.#timerToken;
    this.#closesAt = this.#context.clock().add({ minutes: settings.lobbyMinutes });
    this.#timer = setTimeout(() => {
      this.#queueWork(async () => {
        if (token !== this.#timerToken || this.closed || this.#game !== null) return;
        this.#markClosed('idle');
        await this.#showClosed();
      });
    }, settings.lobbyMinutes * 60_000);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerToken += 1;
    this.#closesAt = null;
  }

  #stopCollector(): void {
    this.#collector?.stop(DONE);
    this.#collector = null;
  }

  async #respond(press: Press): Promise<void> {
    try {
      await press.update(this.#render());
      return;
    } catch (error) {
      this.#log.warn({ err: loggableError(error) }, 'could not answer a lobby press');
    }
    await this.#refresh();
  }

  async #refresh(): Promise<void> {
    const lobby = this.#lobby;
    if (lobby === null) return;
    try {
      await lobby.edit(this.#render());
    } catch (error) {
      this.#log.warn({ err: loggableError(error) }, 'could not edit a table lobby');
    }
  }

  #render(): LobbyMessage {
    return lobbyMessage(this.#locale, this.#view());
  }

  #view(): LobbyView {
    const { number } = this;
    if (this.#closedReason !== null) return { state: 'closed', number, reason: this.#closedReason };
    if (this.#game !== null) return { state: 'playing', number, game: this.#game.game };
    const step = this.#step;
    return {
      state: 'open',
      number,
      players: [...this.#players],
      closesAt: this.#closesAt ?? this.#context.clock().add({ minutes: settings.lobbyMinutes }),
      customId: (action) => `${HOST_PREFIX}:${this.id}:${action}:${String(step)}`,
    };
  }
}

/** The real table threads; tests use the fakes in test/helpers/tables.ts. */
export function createTableHosts(numbers: TableNumbers): TableHosts {
  return { open: (options) => ThreadTableHost.open(numbers, options) };
}
