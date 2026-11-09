import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/client.js';

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
});
