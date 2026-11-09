import type { REST } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../src/bot/types.js';
import { logger } from '../../src/core/logger.js';
import { deployCommands } from '../../src/deploy-commands.js';

const CLIENT_ID = '900000000000000001';
const DEV_GUILD_ID = '100000000000000009';

function command(name: string): Command {
  return {
    data: { name, toJSON: () => ({ name, description: `The ${name} command` }) },
    execute: () => Promise.resolve(),
  };
}

function fakeRest(): { put: ReturnType<typeof vi.fn<REST['put']>> } {
  return { put: vi.fn<REST['put']>(() => Promise.resolve([])) };
}

const commands = [command('dailygift'), command('help')];
const body = [
  { name: 'dailygift', description: 'The dailygift command' },
  { name: 'help', description: 'The help command' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deployCommands', () => {
  it('registers every command in DEV_GUILD_ID when it is set', async () => {
    const rest = fakeRest();
    const info = vi.spyOn(logger, 'info');

    await deployCommands(rest, { DISCORD_CLIENT_ID: CLIENT_ID, DEV_GUILD_ID }, commands);

    expect(rest.put).toHaveBeenCalledExactlyOnceWith(
      `/applications/${CLIENT_ID}/guilds/${DEV_GUILD_ID}/commands`,
      { body },
    );
    expect(info).toHaveBeenCalledWith(
      { count: 2, guildId: DEV_GUILD_ID },
      `registered 2 commands in server ${DEV_GUILD_ID}`,
    );
  });

  it('registers every command globally without DEV_GUILD_ID', async () => {
    const rest = fakeRest();
    const info = vi.spyOn(logger, 'info');

    await deployCommands(rest, { DISCORD_CLIENT_ID: CLIENT_ID, DEV_GUILD_ID: undefined }, commands);

    expect(rest.put).toHaveBeenCalledExactlyOnceWith(`/applications/${CLIENT_ID}/commands`, {
      body,
    });
    expect(info).toHaveBeenCalledWith({ count: 2 }, 'registered 2 commands globally');
  });

  it('does not deploy when the module is imported', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.resetModules();

    await import('../../src/deploy-commands.js');

    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });
});
