import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTableNumbers } from '../../src/core/table-numbers.js';
import { GUILD, OTHER_GUILD, openTestDatabase, testDatabaseUrl, truncateAll } from './helpers.js';

const { pool, db } = openTestDatabase();
const numbers = createTableNumbers(db);

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** Asks through its own connection: the pool's connections are the ones waiting. */
async function waitForSessionsWaitingOnLocks(watcher: pg.Client, count: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await watcher.query<{ waiting: number }>(`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (Number(result.rows[0]?.waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${String(count)} sessions waiting on a lock`);
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  return client;
}

const sorted = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe('table numbers (SPEC §4)', () => {
  it('counts 1, 2, 3 per server', async () => {
    expect(await numbers.next(GUILD)).toBe(1);
    expect(await numbers.next(GUILD)).toBe(2);
    expect(await numbers.next(GUILD)).toBe(3);
  });

  it('counts every server on its own', async () => {
    await numbers.next(GUILD);
    await numbers.next(GUILD);

    expect(await numbers.next(OTHER_GUILD)).toBe(1);
    expect(await numbers.next(GUILD)).toBe(3);
    expect(await numbers.next(OTHER_GUILD)).toBe(2);
  });

  it('keeps counting with a new connection, as after a restart', async () => {
    await numbers.next(GUILD);
    await numbers.next(GUILD);
    const restarted = openTestDatabase();
    try {
      expect(await createTableNumbers(restarted.db).next(GUILD)).toBe(3);
    } finally {
      await restarted.pool.end();
    }
  });

  it('gives 10 calls at the same time for a new server 10 different numbers', async () => {
    const got = await Promise.all(range(1, 10).map(() => numbers.next(GUILD)));

    expect(sorted(got)).toEqual(range(1, 10));
  });

  it('gives 10 different numbers to calls that all wait for the same server row', async () => {
    await numbers.next(GUILD);
    // Another session holds the row, so all 10 calls are in flight together before any can write.
    const holder = await connect();
    const watcher = await connect();
    let got: number[];
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT last_number FROM guild_table_counters WHERE guild_id = $1 FOR UPDATE',
        [GUILD],
      );
      const calls = Promise.all(range(1, 10).map(() => numbers.next(GUILD)));
      await waitForSessionsWaitingOnLocks(watcher, 10);
      await holder.query('COMMIT');
      got = await calls;
    } finally {
      await holder.end();
      await watcher.end();
    }

    expect(sorted(got)).toEqual(range(2, 11));
  });
});
