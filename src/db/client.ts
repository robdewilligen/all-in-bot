import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { logger } from '../core/logger.js';

export type Database = NodePgDatabase;

/** One pool for the whole app (SPEC §10); index.ts ends it on shutdown. */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
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
