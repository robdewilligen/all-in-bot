import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { guildTableCounters } from '../db/schema.js';

/** The numbers in table thread names: 1, 2, 3… per server, kept across restarts (SPEC §4). */
export interface TableNumbers {
  /** The server's next table number; two calls never get the same one. */
  next(guildId: string): Promise<number>;
}

export function createTableNumbers(db: Database): TableNumbers {
  return {
    async next(guildId) {
      // One statement: concurrent calls queue on the server's row instead of reading the same value.
      const [row] = await db
        .insert(guildTableCounters)
        .values({ guildId, lastNumber: 1 })
        .onConflictDoUpdate({
          target: guildTableCounters.guildId,
          set: { lastNumber: sql`${guildTableCounters.lastNumber} + 1` },
        })
        .returning({ number: guildTableCounters.lastNumber });
      if (row === undefined) throw new Error(`no table number came back for guild ${guildId}`);
      return row.number;
    },
  };
}
