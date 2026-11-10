import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { createWallet, type PlayerIdentity, type Wallet } from '../../src/core/wallet.js';
import { createDatabase, createPool, type Database } from '../../src/db/client.js';
import { ledgerEntries, players } from '../../src/db/schema.js';

export const GUILD = '100000000000000001';
export const OTHER_GUILD = '100000000000000002';

/** TEST_DATABASE_URL, provided it names a database the tests may wipe (`…_test`). */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set. Put it in .env; the database PC prints it at the end of its setup.',
    );
  }
  let name: string;
  try {
    name = new URL(url).pathname.slice(1);
  } catch {
    // Not the URL itself in the message: it holds a password.
    throw new Error('TEST_DATABASE_URL is not a valid postgresql:// URL.');
  }
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL names "${name}"; the tests wipe their database, so its name must end in _test.`,
    );
  }
  return url;
}

export interface TestDatabase {
  readonly pool: pg.Pool;
  readonly db: Database;
  readonly wallet: Wallet;
}

export function openTestDatabase(): TestDatabase {
  const pool = createPool(testDatabaseUrl());
  const db = createDatabase(pool);
  return { pool, db, wallet: createWallet(db, { timeZone: 'Europe/Amsterdam' }) };
}

export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE ledger_entries, rounds, table_rounds, daily_claims, players, guild_table_counters RESTART IDENTITY`,
  );
}

export function player(n: number, guildId = GUILD): PlayerIdentity {
  return { guildId, userId: `2${String(n).padStart(17, '0')}`, displayName: `Player ${String(n)}` };
}

/** A player with a balance, booked as a daily gift so the ledger still adds up. */
export async function seed(db: Database, who: PlayerIdentity, balance: number): Promise<void> {
  await db.insert(players).values({ ...who, balance });
  if (balance > 0) {
    await db.insert(ledgerEntries).values({
      guildId: who.guildId,
      userId: who.userId,
      kind: 'daily',
      amount: balance,
      balanceAfter: balance,
    });
  }
}

/** Ledger rows whose running total per player differs from their balance_after, or players whose balance differs from their ledger. */
export async function ledgerMismatches(db: Database): Promise<unknown[]> {
  const entries = await db.execute(sql`
    SELECT id FROM (
      SELECT id, balance_after,
        sum(amount) OVER (PARTITION BY guild_id, user_id ORDER BY id) AS running
      FROM ledger_entries
    ) AS entries
    WHERE running <> balance_after`);
  const balances = await db.execute(sql`
    SELECT p.guild_id, p.user_id
    FROM players p
    LEFT JOIN ledger_entries l ON l.guild_id = p.guild_id AND l.user_id = p.user_id
    GROUP BY p.guild_id, p.user_id, p.balance
    HAVING p.balance <> coalesce(sum(l.amount), 0)`);
  return [...entries.rows, ...balances.rows];
}
