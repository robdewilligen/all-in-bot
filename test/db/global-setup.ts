import { createPool } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { testDatabaseUrl } from './helpers.js';

/** Brings the test database to the latest migration once, before the database tests run. */
export default async function setup(): Promise<void> {
  const pool = createPool(testDatabaseUrl());
  try {
    await migrateDatabase(pool);
  } finally {
    await pool.end();
  }
}
