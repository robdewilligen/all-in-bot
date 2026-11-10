import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { configDefaults, defineConfig } from 'vitest/config';

// Local runs take TEST_DATABASE_URL from .env; CI sets it in the workflow. Only that variable
// reaches the tests, so none of them can touch the dev database through DATABASE_URL.
const dotenv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const filled = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;
const testDatabaseUrl = filled(process.env.TEST_DATABASE_URL) ?? filled(dotenv.TEST_DATABASE_URL);
const devDatabaseUrl = filled(process.env.DATABASE_URL) ?? filled(dotenv.DATABASE_URL);

// By database name, so `localhost` and `127.0.0.1` spellings of one database still match.
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.slice(1);
  } catch {
    return url;
  }
}

if (
  testDatabaseUrl !== undefined &&
  devDatabaseUrl !== undefined &&
  databaseName(testDatabaseUrl) === databaseName(devDatabaseUrl)
) {
  throw new Error('TEST_DATABASE_URL names the same database as DATABASE_URL; tests wipe it.');
}
if (testDatabaseUrl !== undefined) process.env.TEST_DATABASE_URL = testDatabaseUrl;
delete process.env.DATABASE_URL;

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/db/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['test/db/**/*.test.ts'],
          globalSetup: ['test/db/global-setup.ts'],
          // One shared database, truncated between tests.
          fileParallelism: false,
        },
      },
    ],
  },
});
