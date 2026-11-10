import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { logger } from '../core/logger.js';

export type Database = NodePgDatabase;

export type PoolTimeouts = Pick<
  pg.PoolConfig,
  | 'connectionTimeoutMillis'
  | 'statement_timeout'
  | 'query_timeout'
  | 'idle_in_transaction_session_timeout'
>;

/**
 * The bot's limits: a hung database call fails instead of holding a table, and with it the
 * server's seating queue, forever. Migrations run without them.
 */
export const BOT_TIMEOUTS: PoolTimeouts = {
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  query_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
};

/** One pool for the whole app (SPEC §10); index.ts ends it on shutdown. */
export function createPool(connectionString: string, timeouts: PoolTimeouts = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, ...timeouts });
  // A lost connection emits 'error', which crashes the bot without a listener. The pool covers
  // idle clients; the per-client listener covers checked-out ones, whose query still rejects.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle database client failed');
  });
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.warn({ err: error }, 'database connection failed');
    });
  });
  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle({ client: pool });
}
