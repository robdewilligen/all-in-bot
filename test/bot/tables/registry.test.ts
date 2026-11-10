import { describe, expect, it } from 'vitest';
import {
  ActionQueue,
  customIdPrefix,
  TableRegistry,
  type HostedTable,
  type LiveTable,
} from '../../../src/bot/tables/registry.js';
import { PlayerError } from '../../../src/core/errors.js';
import type { TableGame } from '../../../src/core/wallet.js';

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const everyChannel = (): boolean => true;

interface FakeTable extends LiveTable {
  room: boolean;
  closeCalls: number;
}

function fakeTable(
  id: string,
  options: {
    game?: TableGame;
    guildId?: string;
    channelId?: string;
    room?: boolean;
    failToClose?: boolean;
    onClose?: () => void;
  } = {},
): FakeTable {
  const table: FakeTable = {
    id,
    game: options.game ?? 'roulette',
    guildId: options.guildId ?? GUILD,
    channelId: options.channelId ?? 'channel-1',
    room: options.room ?? true,
    closeCalls: 0,
    hasRoom: () => table.room,
    close: () => {
      table.closeCalls += 1;
      options.onClose?.();
      return options.failToClose === true
        ? Promise.reject(new Error(`table ${id} would not close`))
        : Promise.resolve();
    },
  };
  return table;
}

interface FakeHosted extends HostedTable {
  closeCalls: number;
}

function fakeHosted(
  id: string,
  threadId: string,
  options: { guildId?: string; onClose?: () => void } = {},
): FakeHosted {
  const host: FakeHosted = {
    id,
    threadId,
    guildId: options.guildId ?? GUILD,
    closeCalls: 0,
    close: () => {
      host.closeCalls += 1;
      options.onClose?.();
      return Promise.resolve();
    },
  };
  return host;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('seating (SPEC §4)', () => {
  it('prefers a table with room in this channel, then one in another channel', () => {
    const tables = new TableRegistry();
    const elsewhere = fakeTable('a', { channelId: 'channel-2' });
    const here = fakeTable('b', { channelId: 'channel-1' });
    tables.add(elsewhere);
    tables.add(here);
    expect(tables.tableWithRoom('roulette', GUILD, 'channel-1', everyChannel)).toBe(here);
    expect(tables.tableWithRoom('roulette', GUILD, 'channel-3', everyChannel)).toBe(elsewhere);
  });

  it('skips full tables, other games and other servers', () => {
    const tables = new TableRegistry();
    tables.add(fakeTable('full', { room: false }));
    tables.add(fakeTable('blackjack', { game: 'blackjack' }));
    tables.add(fakeTable('abroad', { guildId: OTHER_GUILD }));
    expect(tables.tableWithRoom('roulette', GUILD, 'channel-1', everyChannel)).toBeUndefined();
    const open = fakeTable('open', { channelId: 'channel-9' });
    tables.add(open);
    expect(tables.tableWithRoom('roulette', GUILD, 'channel-1', everyChannel)).toBe(open);
  });

  it('never seats a player at a table in a channel they cannot see', () => {
    const tables = new TableRegistry();
    const hidden = fakeTable('hidden', { channelId: 'staff' });
    const visible = fakeTable('visible', { channelId: 'casino-2' });
    tables.add(hidden);
    const asked: string[] = [];
    const canView = (channelId: string): boolean => {
      asked.push(channelId);
      return channelId !== 'staff';
    };
    expect(tables.tableWithRoom('roulette', GUILD, 'casino', canView)).toBeUndefined();
    tables.add(visible);
    expect(tables.tableWithRoom('roulette', GUILD, 'casino', canView)).toBe(visible);
    expect(asked).toContain('staff');
  });

  it("doesn't ask about the player's own channel: they typed the command there", () => {
    const tables = new TableRegistry();
    const here = fakeTable('here', { channelId: 'casino' });
    tables.add(here);
    expect(tables.tableWithRoom('roulette', GUILD, 'casino', () => false)).toBe(here);
  });
});

describe('one table per game per server', () => {
  it('remembers where a player plays and refuses a second table of that game', () => {
    const tables = new TableRegistry();
    const first = fakeTable('a');
    const second = fakeTable('b');
    const blackjack = fakeTable('c', { game: 'blackjack' });
    [first, second, blackjack].forEach((table) => {
      tables.add(table);
    });
    tables.seat(first, 'alice');
    expect(tables.tableOf('roulette', GUILD, 'alice')).toBe(first);
    expect(() => {
      tables.seat(second, 'alice');
    }).toThrow(/already plays/);
    tables.seat(blackjack, 'alice');
    expect(tables.tableOf('blackjack', GUILD, 'alice')).toBe(blackjack);
    expect(tables.tableOf('roulette', OTHER_GUILD, 'alice')).toBeUndefined();
  });

  it('frees the seat when the player leaves or the table goes away', () => {
    const tables = new TableRegistry();
    const table = fakeTable('a');
    tables.add(table);
    tables.seat(table, 'alice');
    tables.seat(table, 'bob');
    tables.unseat(table, 'alice');
    expect(tables.tableOf('roulette', GUILD, 'alice')).toBeUndefined();
    tables.remove(table);
    expect(tables.tableOf('roulette', GUILD, 'bob')).toBeUndefined();
    expect(tables.get(GUILD, 'a')).toBeUndefined();
  });
});

describe('table threads', () => {
  it('finds a live table by its thread, per server, until it is removed', () => {
    const tables = new TableRegistry();
    const host = fakeHosted('h1', 'thread-1');
    tables.addHost(host);
    expect(tables.hostIn(GUILD, 'thread-1')).toBe(host);
    expect(tables.hostIn(GUILD, 'channel-1')).toBeUndefined();
    expect(tables.hostIn(OTHER_GUILD, 'thread-1')).toBeUndefined();
    tables.removeHost(fakeHosted('h1', 'thread-1'));
    expect(tables.hostIn(GUILD, 'thread-1')).toBe(host);
    tables.removeHost(host);
    expect(tables.hostIn(GUILD, 'thread-1')).toBeUndefined();
    expect(tables.allHosts()).toEqual([]);
  });
});

describe('custom IDs', () => {
  it('belong to a live table only with the right prefix, table ID and server', () => {
    const tables = new TableRegistry();
    const roulette = fakeTable(tables.newTableId());
    const blackjack = fakeTable(tables.newTableId(), { game: 'blackjack' });
    tables.add(roulette);
    tables.add(blackjack);
    expect(tables.owns(GUILD, `${customIdPrefix('roulette')}:${roulette.id}:bet`)).toBe(true);
    expect(tables.owns(GUILD, `bj:${blackjack.id}:hit:3`)).toBe(true);
    expect(tables.owns(GUILD, `bj:${roulette.id}:hit:3`)).toBe(false);
    expect(tables.owns(OTHER_GUILD, `rl:${roulette.id}:bet`)).toBe(false);
    expect(tables.owns(null, `rl:${roulette.id}:bet`)).toBe(false);
    expect(tables.owns(GUILD, 'rl')).toBe(false);
    expect(tables.owns(GUILD, 'help:topic')).toBe(false);
    tables.remove(roulette);
    expect(tables.owns(GUILD, `rl:${roulette.id}:bet`)).toBe(false);
  });

  it("belong to a live table thread's lobby by the host ID, not the thread ID", () => {
    const tables = new TableRegistry();
    const host = fakeHosted('x-1', 'thread-1');
    tables.addHost(host);
    expect(tables.owns(GUILD, 'tb:x-1:roulette:1')).toBe(true);
    expect(tables.owns(GUILD, 'tb:thread-1:roulette:1')).toBe(false);
    expect(tables.owns(OTHER_GUILD, 'tb:x-1:roulette:1')).toBe(false);
    expect(tables.owns(GUILD, 'bj:x-1:hit:1')).toBe(false);
    tables.removeHost(host);
    expect(tables.owns(GUILD, 'tb:x-1:roulette:1')).toBe(false);
  });

  it('leave a form the live table stopped waiting for to interactionCreate, but keep it live', () => {
    const tables = new TableRegistry();
    const game = fakeTable(tables.newTableId(), { game: 'blackjack' });
    const host = fakeHosted('h-1', 'thread-1');
    const answers = (customId: string): boolean => !customId.endsWith(':expired');
    tables.add({ ...game, answers });
    tables.addHost({ ...host, answers });

    expect(tables.owns(GUILD, `bj:${game.id}:bet:expired`)).toBe(false);
    expect(tables.isLive(GUILD, `bj:${game.id}:bet:expired`)).toBe(true);
    expect(tables.owns(GUILD, `bj:${game.id}:bet:2`)).toBe(true);
    expect(tables.owns(GUILD, 'tb:h-1:form-roulette:expired')).toBe(false);
    expect(tables.isLive(GUILD, 'tb:h-1:form-roulette:expired')).toBe(true);
    expect(tables.isLive(GUILD, 'tb:h-2:form-roulette:expired')).toBe(false);
  });

  it('get table IDs that are unique within the process', () => {
    const tables = new TableRegistry();
    const ids = new Set(Array.from({ length: 50 }, () => tables.newTableId()));
    expect(ids.size).toBe(50);
  });

  it("never reuse an ID of an earlier process, so a stale button can't match a new table", () => {
    const before = new TableRegistry('boot1');
    const after = new TableRegistry('boot2');
    const stale = fakeTable(before.newTableId(), { game: 'blackjack' });
    const live = fakeTable(after.newTableId(), { game: 'blackjack' });
    after.add(live);
    expect(stale.id).not.toBe(live.id);
    expect(after.owns(GUILD, `bj:${stale.id}:same:4`)).toBe(false);
    expect(after.owns(GUILD, `bj:${live.id}:same:4`)).toBe(true);
  });
});

describe('one action at a time', () => {
  it('runs a table queue in order, and a failed action does not block the next', async () => {
    const queue = new ActionQueue();
    const events: string[] = [];
    const gate = deferred();
    const first = queue.run(async () => {
      events.push('first starts');
      await gate.promise;
      events.push('first fails');
      throw new Error('first failed');
    });
    const second = queue.run(() => {
      events.push('second runs');
      return Promise.resolve('second done');
    });
    await Promise.resolve();
    expect(events).toEqual(['first starts']);
    gate.resolve();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second done');
    expect(events).toEqual(['first starts', 'first fails', 'second runs']);
  });

  it('seats one command at a time per server, and servers do not wait for each other', async () => {
    const tables = new TableRegistry();
    const events: string[] = [];
    const gate = deferred();
    const slow = tables.inGuild(GUILD, async () => {
      events.push('guild work 1 starts');
      await gate.promise;
      events.push('guild work 1 ends');
    });
    const queued = tables.inGuild(GUILD, () => {
      events.push('guild work 2');
      return Promise.resolve();
    });
    const elsewhere = tables.inGuild(OTHER_GUILD, () => {
      events.push('other guild');
      return Promise.resolve();
    });
    await elsewhere;
    expect(events).toEqual(['guild work 1 starts', 'other guild']);
    gate.resolve();
    await Promise.all([slow, queued]);
    expect(events).toEqual([
      'guild work 1 starts',
      'other guild',
      'guild work 1 ends',
      'guild work 2',
    ]);
  });
});

describe('shutdown', () => {
  it('closes every table, forgets them and reports the ones that failed', async () => {
    const tables = new TableRegistry();
    const ok = fakeTable('a');
    const stuck = fakeTable('b', { guildId: OTHER_GUILD, failToClose: true });
    tables.add(ok);
    tables.add(stuck);
    expect(tables.closing).toBe(false);
    const failures = await tables.closeAll();
    expect(tables.closing).toBe(true);
    expect([ok.closeCalls, stuck.closeCalls]).toEqual([1, 1]);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/would not close/);
    expect(tables.all()).toEqual([]);
  });

  it('closes the games first, then the table threads, and forgets the threads', async () => {
    const tables = new TableRegistry();
    const order: string[] = [];
    tables.add(fakeTable('game', { onClose: () => order.push('game') }));
    tables.addHost(fakeHosted('h1', 'thread-1', { onClose: () => order.push('thread') }));
    await tables.closeAll();
    expect(order).toEqual(['game', 'thread']);
    expect(tables.allHosts()).toEqual([]);
  });

  it('refuses seating work that starts once shutdown has begun', async () => {
    const tables = new TableRegistry();
    await tables.closeAll();
    let ran = false;
    const late = tables.inGuild(GUILD, () => {
      ran = true;
      return Promise.resolve();
    });
    await expect(late).rejects.toBeInstanceOf(PlayerError);
    await expect(late).rejects.toThrow('errors.restarting');
    expect(ran).toBe(false);
  });

  it('waits for seating that already started, so a table it opens is closed too', async () => {
    const tables = new TableRegistry();
    const gate = deferred();
    const started = deferred();
    const late = fakeTable('late');
    const opening = tables.inGuild(GUILD, async () => {
      started.resolve();
      await gate.promise;
      tables.add(late);
    });
    await started.promise;
    let queuedRan = false;
    const queued = tables
      .inGuild(GUILD, () => {
        queuedRan = true;
        return Promise.resolve();
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    const closing = tables.closeAll();
    gate.resolve();
    await opening;
    await closing;
    expect(late.closeCalls).toBe(1);
    expect(tables.all()).toEqual([]);
    expect(await queued).toEqual(new PlayerError('errors.restarting'));
    expect(queuedRan).toBe(false);
  });
});
