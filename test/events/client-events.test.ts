import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import clientError from '../../src/events/client-error.js';
import clientReady from '../../src/events/client-ready.js';
import { captureLogs, fakeContext } from '../helpers/context.js';

describe('clientReady', () => {
  it('logs the bot tag and the number of servers, once', () => {
    const { logger, lines } = captureLogs();
    const client = {
      user: { tag: 'All-in#4242' },
      guilds: { cache: { size: 3 } },
    } as unknown as Client<true>;

    clientReady.execute(fakeContext({ logger }), client);

    expect(clientReady.once).toBe(true);
    expect(lines).toEqual([
      expect.objectContaining({ level: 30, msg: 'logged in', tag: 'All-in#4242', guilds: 3 }),
    ]);
  });
});

describe('client error', () => {
  it('logs the error', () => {
    const { logger, lines } = captureLogs();

    clientError.execute(fakeContext({ logger }), new Error('gateway hiccup'));

    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'Discord client error',
        err: expect.objectContaining({ message: 'gateway hiccup' }) as unknown,
      }),
    ]);
  });
});
