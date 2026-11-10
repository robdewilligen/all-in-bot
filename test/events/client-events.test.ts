import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import clientError from '../../src/events/client-error.js';
import clientReady from '../../src/events/client-ready.js';
import { captureLogs, fakeContext, FIXED_NOW } from '../helpers/context.js';

const client = {
  user: { tag: 'All-in#4242' },
  guilds: { cache: { size: 3 } },
} as unknown as Client<true>;

describe('clientReady', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'all-in-ready-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('logs the bot tag and the number of servers, once', async () => {
    vi.stubEnv('READY_FILE', undefined);
    const { logger, lines } = captureLogs();

    await clientReady.execute(fakeContext({ logger }), client);

    expect(clientReady.once).toBe(true);
    expect(lines).toEqual([
      expect.objectContaining({ level: 30, msg: 'logged in', tag: 'All-in#4242', guilds: 3 }),
    ]);
  });

  it('writes READY_FILE once logged in, for the container healthcheck', async () => {
    const readyFile = join(directory, 'ready');
    vi.stubEnv('READY_FILE', readyFile);
    const { logger, lines } = captureLogs();

    await clientReady.execute(fakeContext({ logger }), client);

    expect(await readFile(readyFile, 'utf8')).toBe(`${FIXED_NOW.toString()}\n`);
    expect(lines).toHaveLength(1);
  });

  it('logs a warning instead of failing when READY_FILE cannot be written', async () => {
    const readyFile = join(directory, 'missing-folder', 'ready');
    vi.stubEnv('READY_FILE', readyFile);
    const { logger, lines } = captureLogs();

    await clientReady.execute(fakeContext({ logger }), client);

    expect(lines).toEqual([
      expect.objectContaining({ msg: 'logged in' }),
      expect.objectContaining({ level: 40, msg: 'could not write the ready file', readyFile }),
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
