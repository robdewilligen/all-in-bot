import { Collection, type REST } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../src/bot/types.js';
import { EnvError } from '../../src/config/env.js';
import { logger } from '../../src/core/logger.js';
import { commandDefinitions, deployCommands, main, PRINT_FLAG } from '../../src/deploy-commands.js';

const CLIENT_ID = '900000000000000001';
const DEV_GUILD_ID = '100000000000000009';

function command(name: string, description = `The ${name} command`): Command {
  return {
    data: { name, toJSON: () => ({ name, description }) },
    execute: () => Promise.resolve(),
  };
}

function fakeRest(): { put: ReturnType<typeof vi.fn<REST['put']>> } {
  return { put: vi.fn<REST['put']>(() => Promise.resolve([])) };
}

function loaded(...list: Command[]): () => Promise<Collection<string, Command>> {
  return () => Promise.resolve(new Collection(list.map((item) => [item.data.name, item] as const)));
}

const commands = [command('dailygift'), command('help')];
const body = [
  { name: 'dailygift', description: 'The dailygift command' },
  { name: 'help', description: 'The help command' },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

describe('commandDefinitions', () => {
  it('is the body that deployCommands sends, on one line', async () => {
    const rest = fakeRest();
    await deployCommands(rest, { DISCORD_CLIENT_ID: CLIENT_ID, DEV_GUILD_ID: undefined }, commands);

    const text = commandDefinitions(commands);

    expect(text).not.toContain('\n');
    expect(JSON.parse(text) as unknown).toEqual(rest.put.mock.calls[0]?.[1]?.body);
  });

  it('gives the same text for the same definitions', () => {
    expect(commandDefinitions([command('dailygift'), command('help')])).toBe(
      commandDefinitions(commands),
    );
  });

  it('changes when a definition changes', () => {
    const before = commandDefinitions(commands);

    expect(commandDefinitions([command('dailygift'), command('help', 'Rules')])).not.toBe(before);
    expect(commandDefinitions([command('dailygift')])).not.toBe(before);
  });
});

describe('main', () => {
  it('prints the definitions with --print, without the Discord values', async () => {
    vi.stubEnv('DISCORD_TOKEN', undefined);
    vi.stubEnv('DISCORD_CLIENT_ID', undefined);
    const written: string[] = [];

    await main([PRINT_FLAG], loaded(...commands), (text) => written.push(text));

    expect(written).toEqual([`${commandDefinitions(commands)}\n`]);
  });

  it('needs the Discord values to register', async () => {
    vi.stubEnv('DISCORD_TOKEN', undefined);
    vi.stubEnv('DISCORD_CLIENT_ID', undefined);
    const written: string[] = [];

    await expect(main([], loaded(...commands), (text) => written.push(text))).rejects.toThrow(
      EnvError,
    );
    expect(written).toEqual([]);
  });
});
