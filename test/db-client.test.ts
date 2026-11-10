import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { BOT_TIMEOUTS, createPool } from '../src/db/client.js';

// Nothing connects: a pool only opens a connection for its first query.
const pool = createPool('postgresql://allin:secret@localhost:1/allin_test');

afterAll(async () => {
  await pool.end();
});

describe('the database pool', () => {
  it('survives a connection that drops while a client is checked out', () => {
    const client = new EventEmitter();
    pool.emit('connect', client);
    expect(() =>
      client.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
  });

  it('survives an idle client that fails', () => {
    expect(() => pool.emit('error', new Error('terminating connection'), {})).not.toThrow();
  });

  it("gives the bot's pool timeouts, so a hung call can't hold a table forever", async () => {
    const bot = createPool('postgresql://allin:secret@localhost:1/allin_test', BOT_TIMEOUTS);
    try {
      expect(bot.options).toMatchObject({
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        query_timeout: 15_000,
        idle_in_transaction_session_timeout: 30_000,
      });
      expect(pool.options).not.toHaveProperty('statement_timeout');
    } finally {
      await bot.end();
    }
  });
});
