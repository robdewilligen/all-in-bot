import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDatabase } from './client.js';

// From src/db or dist/db, the repo's drizzle/ folder is two levels up.
const migrationsFolder = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** Applies every pending migration in drizzle/ to the pool's database. */
export async function migrateDatabase(pool: pg.Pool): Promise<void> {
  await migrate(createDatabase(pool), { migrationsFolder });
}
