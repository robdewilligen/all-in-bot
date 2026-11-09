import { databaseEnvSchema, EnvError, parseEnv } from '../config/env.js';
import { logger } from '../core/logger.js';
import { createPool } from './client.js';
import { migrateDatabase } from './migrations.js';

// Needs only DATABASE_URL: the setup scripts run this once per database on the database PC.
async function main(): Promise<void> {
  const env = parseEnv(databaseEnvSchema);
  const pool = createPool(env.DATABASE_URL);
  try {
    await migrateDatabase(pool);
    const target = new URL(env.DATABASE_URL);
    logger.info({ database: target.pathname.slice(1), host: target.host }, 'migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof EnvError) {
    console.error(error.message);
  } else {
    logger.error({ err: error }, 'migration failed');
  }
  process.exitCode = 1;
});
