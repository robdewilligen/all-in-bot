import { describe, expect, it } from 'vitest';
import {
  botEnvSchema,
  databaseEnvSchema,
  discordEnvSchema,
  EnvError,
  parseEnv,
} from '../../src/config/env.js';

const valid = {
  DISCORD_TOKEN: 'token-value',
  DISCORD_CLIENT_ID: '123456789012345678',
  DATABASE_URL: 'postgresql://allin_dev:secret@db-host:5432/allin_dev',
};

function problemsWith(source: Record<string, string>): string {
  try {
    parseEnv(botEnvSchema, source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).message;
  }
  throw new Error('parseEnv accepted an invalid environment');
}

describe('the environment', () => {
  it('accepts a complete .env and fills in the defaults', () => {
    expect(parseEnv(botEnvSchema, valid)).toEqual({
      ...valid,
      DAILY_RESET_TIMEZONE: 'Europe/Amsterdam',
      LOG_LEVEL: 'info',
    });
  });

  it('treats empty values as missing, so the defaults apply', () => {
    const env = parseEnv(botEnvSchema, {
      ...valid,
      DEV_GUILD_ID: '',
      DAILY_RESET_TIMEZONE: ' ',
      LOG_LEVEL: '',
    });
    expect(env.DEV_GUILD_ID).toBeUndefined();
    expect(env.DAILY_RESET_TIMEZONE).toBe('Europe/Amsterdam');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names each missing variable', () => {
    const message = problemsWith({});
    expect(message).toMatch(/^ {2}DATABASE_URL is missing$/m);
    expect(message).toMatch(/^ {2}DISCORD_TOKEN is missing$/m);
    expect(message).toMatch(/^ {2}DISCORD_CLIENT_ID is missing$/m);
    expect(message).not.toMatch(/DEV_GUILD_ID|DAILY_RESET_TIMEZONE|LOG_LEVEL/);
  });

  it('names each invalid variable without repeating its value', () => {
    const message = problemsWith({
      DISCORD_TOKEN: 'super-secret-token',
      DISCORD_CLIENT_ID: 'my-app',
      DEV_GUILD_ID: '42',
      DATABASE_URL: 'mysql://root:hunter2@localhost/allin',
      DAILY_RESET_TIMEZONE: 'Mars/Olympus_Mons',
      LOG_LEVEL: 'loud',
    });
    expect(message).toMatch(/^ {2}DISCORD_CLIENT_ID must be a Discord ID/m);
    expect(message).toMatch(/^ {2}DEV_GUILD_ID must be a Discord ID/m);
    expect(message).toMatch(/^ {2}DATABASE_URL must be a postgresql:\/\/ URL$/m);
    expect(message).toMatch(/^ {2}DAILY_RESET_TIMEZONE must be an IANA time zone/m);
    expect(message).toMatch(/^ {2}LOG_LEVEL must be one of/m);
    expect(message).not.toMatch(/super-secret-token|hunter2|my-app|Olympus|loud/);
  });

  it("rejects the placeholder setup writes for values it couldn't fill in", () => {
    const message = problemsWith({
      ...valid,
      DISCORD_TOKEN: 'change-me',
      DATABASE_URL: 'postgresql://allin_dev:change-me@database-host:5432/allin_dev',
    });
    expect(message).toMatch(/^ {2}DISCORD_TOKEN still holds the setup placeholder$/m);
    expect(message).toMatch(/^ {2}DATABASE_URL still holds the setup placeholder$/m);
  });

  it('accepts postgres:// as well as postgresql://', () => {
    const url = 'postgres://allin:secret@localhost/allin';
    expect(parseEnv(botEnvSchema, { ...valid, DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('lets db:migrate run with only DATABASE_URL, as on the database PC', () => {
    expect(parseEnv(databaseEnvSchema, { DATABASE_URL: valid.DATABASE_URL })).toEqual({
      DATABASE_URL: valid.DATABASE_URL,
    });
  });

  it('lets deploy:commands run without a database', () => {
    const env = parseEnv(discordEnvSchema, {
      DISCORD_TOKEN: valid.DISCORD_TOKEN,
      DISCORD_CLIENT_ID: valid.DISCORD_CLIENT_ID,
      DEV_GUILD_ID: '987654321098765432',
    });
    expect(env.DEV_GUILD_ID).toBe('987654321098765432');
  });
});
