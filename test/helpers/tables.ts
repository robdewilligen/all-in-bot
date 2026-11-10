import type { Message, MessageCreateOptions } from 'discord.js';
import { vi, type Mock } from 'vitest';
import type { LiveTable, TableRegistry } from '../../src/bot/tables/registry.js';
import type {
  GameEnd,
  OpenHostOptions,
  TableHost,
  TableHosts,
} from '../../src/bot/tables/table.js';
import type { TableGame } from '../../src/core/wallet.js';
import type { FakeChannel, FakeThread } from './discord.js';

const GAME_NAMES: Readonly<Record<TableGame, string>> = {
  roulette: 'Roulette',
  blackjack: 'Blackjack',
};

/**
 * A table thread for game tests: it posts into a FakeThread and records begin, end and close,
 * without a lobby. The real TableHost has its own tests.
 */
export class FakeHost implements TableHost {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly players = new Set<string>();
  readonly begun: LiveTable[] = [];
  readonly ends: { readonly game: LiveTable; readonly reason: GameEnd }[] = [];
  game: LiveTable | null = null;
  closed = false;
  closeCalls = 0;

  constructor(
    readonly tables: TableRegistry,
    readonly thread: FakeThread,
    readonly number: number,
  ) {
    this.id = `h${String(number)}`;
    this.guildId = thread.guildId;
    this.channelId = thread.parentId;
    this.threadId = thread.id;
  }

  get url(): string {
    return this.thread.url;
  }

  send(options: MessageCreateOptions): Promise<Message<true>> {
    return this.thread.send(options) as unknown as Promise<Message<true>>;
  }

  begin(game: LiveTable): void {
    if (this.closed) throw new Error(`table ${this.id} is closed`);
    if (this.game !== null) throw new Error(`table ${this.id} already plays ${this.game.game}`);
    this.game = game;
    this.begun.push(game);
  }

  addPlayer(userId: string): void {
    this.players.add(userId);
  }

  end(game: LiveTable, reason: GameEnd): void {
    if (this.game !== game) return;
    this.game = null;
    this.ends.push({ game, reason });
    if (reason === 'lost') void this.close();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
    this.game = null;
    this.tables.removeHost(this);
    this.thread.archived = true;
    return Promise.resolve();
  }
}

export interface FakeHosts extends TableHosts {
  readonly open: Mock<TableHosts['open']>;
  /** Every table opened, oldest first. */
  readonly opened: FakeHost[];
}

/**
 * Opens FakeHosts in the parent FakeChannel: a FakeThread named "Table #N (Game)", numbered 1, 2,
 * 3… per fakeHosts(), and registered with the context's registry.
 */
export function fakeHosts(): FakeHosts {
  const opened: FakeHost[] = [];
  const open = vi.fn(async (options: OpenHostOptions): Promise<TableHost> => {
    const number = opened.length + 1;
    const name =
      options.game === null
        ? `Table #${String(number)}`
        : `Table #${String(number)} (${GAME_NAMES[options.game]})`;
    const parent = options.parent as unknown as FakeChannel;
    const thread = await parent.threads.create({ name });
    const host = new FakeHost(options.context.tables, thread, number);
    host.addPlayer(options.userId);
    options.context.tables.addHost(host);
    opened.push(host);
    return host;
  });
  return { open, opened };
}
