import { PlayerError } from '../../core/errors.js';
import type { TableGame } from '../../core/wallet.js';

/**
 * A game being played at a table (a roulette spin, a blackjack run), as the registry sees it; the
 * roulette and blackjack tables implement it.
 */
export interface LiveTable {
  readonly id: string;
  readonly game: TableGame;
  readonly guildId: string;
  /** The channel the table's thread is in; seating compares it with the player's channel. */
  readonly channelId: string;
  /** Whether another player can join right now. */
  hasRoom(): boolean;
  /** Stops the table's timers and collector and marks its message as closed (shutdown). */
  close(): Promise<void>;
  /** Whether it will still answer this custom ID: false for a form it stopped waiting for. */
  answers?(customId: string): boolean;
}

/** A table thread ("Table #12 (Roulette)") as the registry sees it; TableHost implements it. */
export interface HostedTable {
  /** In the lobby's custom IDs: `tb:<id>:<action>:<step>`. */
  readonly id: string;
  readonly guildId: string;
  readonly threadId: string;
  /** Shutdown, after its game closed: the lobby says so and the thread is archived. */
  close(): Promise<void>;
  /** Whether it will still answer this custom ID: false for a form it stopped waiting for. */
  answers?(customId: string): boolean;
}

/** The custom-ID prefix of a table's lobby components and bet forms. */
export const HOST_PREFIX = 'tb';

/** Runs actions one at a time, in order; a failing action doesn't hold up the next (SPEC §4). */
export class ActionQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

const PREFIXES: Readonly<Record<TableGame, string>> = { roulette: 'rl', blackjack: 'bj' };

/** The custom-ID prefix of a game's table components, as in `bj:<tableId>:<action>:<step>`. */
export function customIdPrefix(game: TableGame): string {
  return PREFIXES[game];
}

function seatKey(game: TableGame, guildId: string, userId: string): string {
  return `${guildId}:${userId}:${game}`;
}

/**
 * The live tables, by server (SPEC §12). Tables exist only in this process: after a restart their
 * buttons are stale and their rounds have been refunded.
 */
export class TableRegistry {
  readonly #tables = new Map<string, Map<string, LiveTable>>();
  readonly #seats = new Map<string, LiveTable>();
  readonly #guildQueues = new Map<string, ActionQueue>();
  /** By server, then by thread ID. */
  readonly #hosts = new Map<string, Map<string, HostedTable>>();
  readonly #bootId: string;
  #lastId = 0;
  #closing = false;

  /** `bootId` tells this process's custom IDs from those on messages of an earlier one. */
  constructor(bootId: string = Date.now().toString(36)) {
    this.#bootId = bootId;
  }

  /** True once shutdown has begun: from then on no table opens or takes bets. */
  get closing(): boolean {
    return this.#closing;
  }

  /**
   * A short ID for custom IDs. The boot ID keeps it unique across restarts, so a stale button
   * from before a restart never matches a live table (SPEC §4 Restarts).
   */
  newTableId(): string {
    this.#lastId += 1;
    return `${this.#bootId}-${this.#lastId.toString(36)}`;
  }

  /**
   * Seating runs one command at a time per server, so two commands can't both open a table. Once
   * shutdown has begun, work that hasn't started yet fails with `errors.restarting`.
   */
  inGuild<T>(guildId: string, work: () => Promise<T>): Promise<T> {
    let queue = this.#guildQueues.get(guildId);
    if (queue === undefined) {
      queue = new ActionQueue();
      this.#guildQueues.set(guildId, queue);
    }
    return queue.run(() =>
      this.#closing ? Promise.reject(new PlayerError('errors.restarting')) : work(),
    );
  }

  /**
   * SPEC §4 seating: a table with room in this channel, otherwise one in another channel of this
   * server that the player can see, so the link in their confirmation opens.
   */
  tableWithRoom(
    game: TableGame,
    guildId: string,
    channelId: string,
    canView: (channelId: string) => boolean,
  ): LiveTable | undefined {
    const candidates = this.inServer(guildId).filter(
      (table) => table.game === game && table.hasRoom(),
    );
    return (
      candidates.find((table) => table.channelId === channelId) ??
      candidates.find((table) => canView(table.channelId))
    );
  }

  /** The table of this game the player already plays at in this server. */
  tableOf(game: TableGame, guildId: string, userId: string): LiveTable | undefined {
    return this.#seats.get(seatKey(game, guildId, userId));
  }

  get(guildId: string, tableId: string): LiveTable | undefined {
    return this.#tables.get(guildId)?.get(tableId);
  }

  add(table: LiveTable): void {
    let tables = this.#tables.get(table.guildId);
    if (tables === undefined) {
      tables = new Map();
      this.#tables.set(table.guildId, tables);
    }
    tables.set(table.id, table);
  }

  /** Forgets the table and everyone seated at it. */
  remove(table: LiveTable): void {
    const tables = this.#tables.get(table.guildId);
    if (tables?.get(table.id) !== table) return;
    tables.delete(table.id);
    if (tables.size === 0) this.#tables.delete(table.guildId);
    for (const [key, seated] of this.#seats) {
      if (seated === table) this.#seats.delete(key);
    }
  }

  /** Records that the player plays at this table; a player has one table per game per server. */
  seat(table: LiveTable, userId: string): void {
    const key = seatKey(table.game, table.guildId, userId);
    const current = this.#seats.get(key);
    if (current !== undefined && current !== table) {
      throw new Error(`user ${userId} already plays at ${table.game} table ${current.id}`);
    }
    this.#seats.set(key, table);
  }

  unseat(table: LiveTable, userId: string): void {
    const key = seatKey(table.game, table.guildId, userId);
    if (this.#seats.get(key) === table) this.#seats.delete(key);
  }

  addHost(host: HostedTable): void {
    let hosts = this.#hosts.get(host.guildId);
    if (hosts === undefined) {
      hosts = new Map();
      this.#hosts.set(host.guildId, hosts);
    }
    hosts.set(host.threadId, host);
  }

  removeHost(host: HostedTable): void {
    const hosts = this.#hosts.get(host.guildId);
    if (hosts?.get(host.threadId) !== host) return;
    hosts.delete(host.threadId);
    if (hosts.size === 0) this.#hosts.delete(host.guildId);
  }

  /** The live table whose thread this channel is, if it is one. */
  hostIn(guildId: string, channelId: string): HostedTable | undefined {
    return this.#hosts.get(guildId)?.get(channelId);
  }

  /** Whether a live table or game answers this custom ID; then its collector handles the press. */
  owns(guildId: string | null, customId: string): boolean {
    const target = this.#ownerOf(guildId, customId);
    return target !== undefined && (target.answers?.(customId) ?? true);
  }

  /** Whether this custom ID is of a live table or game, also when it no longer answers it. */
  isLive(guildId: string | null, customId: string): boolean {
    return this.#ownerOf(guildId, customId) !== undefined;
  }

  #ownerOf(guildId: string | null, customId: string): LiveTable | HostedTable | undefined {
    const [prefix, tableId] = customId.split(':');
    if (guildId === null || tableId === undefined) return undefined;
    if (prefix === HOST_PREFIX) {
      return [...(this.#hosts.get(guildId)?.values() ?? [])].find((host) => host.id === tableId);
    }
    const table = this.get(guildId, tableId);
    return table !== undefined && PREFIXES[table.game] === prefix ? table : undefined;
  }

  all(): LiveTable[] {
    return [...this.#tables.values()].flatMap((tables) => [...tables.values()]);
  }

  allHosts(): HostedTable[] {
    return [...this.#hosts.values()].flatMap((hosts) => [...hosts.values()]);
  }

  /**
   * Shutdown: closes every game, then every table thread, and returns why any of them failed to
   * close. Games go first, so a table's last message is the game's own "closed" text.
   */
  async closeAll(): Promise<unknown[]> {
    this.#closing = true;
    // Seating that started before this may still open a table; once it is done, all() has it.
    await Promise.all(
      [...this.#guildQueues.values()].map((queue) => queue.run(() => Promise.resolve())),
    );
    const tables = this.all();
    const games = await Promise.allSettled(tables.map((table) => table.close()));
    for (const table of tables) this.remove(table);
    const hosts = this.allHosts();
    const threads = await Promise.allSettled(hosts.map((host) => host.close()));
    for (const host of hosts) this.removeHost(host);
    return [...games, ...threads].flatMap((result): unknown[] =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
  }

  private inServer(guildId: string): LiveTable[] {
    return [...(this.#tables.get(guildId)?.values() ?? [])];
  }
}
