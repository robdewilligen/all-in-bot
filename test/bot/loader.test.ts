import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ApplicationIntegrationType, Client, Events, InteractionContextType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCommands, loadEvents } from '../../src/bot/loader.js';
import { captureLogs, fakeContext } from '../helpers/context.js';

let root: string;
let client: Client | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'all-in-loader-'));
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
});

afterEach(async () => {
  await client?.destroy();
  client = undefined;
  await rm(root, { recursive: true, force: true });
});

async function fixture(path: string, source: string): Promise<string> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source);
  return file;
}

function commandSource(name: string): string {
  return `export default {
  data: { name: '${name}', toJSON: () => ({ name: '${name}', description: 'A test command' }) },
  execute: async () => {},
};
`;
}

function newClient(): Client {
  client = new Client({ intents: [] });
  return client;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('loadCommands', () => {
  it('loads the .ts and .js command modules of every group folder', async () => {
    await fixture('commands/economy/daily.ts', commandSource('dailygift'));
    await fixture('commands/info/help.js', commandSource('help'));
    await fixture('commands/economy/types.d.ts', 'export declare const nothing: never;\n');
    await fixture('commands/economy/daily.js.map', '{}\n');
    await fixture('commands/economy/notes.txt', 'not a module\n');

    const commands = await loadCommands(join(root, 'commands'));

    expect([...commands.keys()].sort()).toEqual(['dailygift', 'help']);
    expect(commands.get('help')?.data.toJSON()).toEqual({
      name: 'help',
      description: 'A test command',
    });
  });

  it.each([
    ['an object without execute', `export default { data: { name: 'x', toJSON: () => ({}) } };\n`],
    [
      'a command without toJSON',
      `export default { data: { name: 'x' }, execute: async () => {} };\n`,
    ],
    ['no default export', commandSource('x').replace('export default', 'export const command =')],
  ])('rejects a module with %s, naming the file', async (_case, source) => {
    const bad = await fixture('commands/economy/broken.ts', source);

    await expect(loadCommands(join(root, 'commands'))).rejects.toThrow(
      `${bad}: the default export is not a command`,
    );
  });

  it('rejects a module that fails to load, naming the file', async () => {
    const bad = await fixture('commands/economy/broken.ts', 'export default {\n');

    await expect(loadCommands(join(root, 'commands'))).rejects.toThrow(
      `${bad}: the module failed to load`,
    );
  });

  it('rejects two commands with the same name, naming both files', async () => {
    const first = await fixture('commands/a/balance.ts', commandSource('balance'));
    const second = await fixture('commands/b/balance.ts', commandSource('balance'));

    await expect(loadCommands(join(root, 'commands'))).rejects.toThrow(
      `${second}: the command name "balance" is already used by ${first}`,
    );
  });

  it("loads the bot's own commands, each registered for servers only", async () => {
    const commands = await loadCommands();

    expect([...commands.keys()]).toEqual(
      expect.arrayContaining(['dailygift', 'balance', 'leaderboard', 'help']),
    );
    for (const [name, command] of commands) {
      expect(command.data.toJSON()).toMatchObject({
        name,
        contexts: [InteractionContextType.Guild],
        integration_types: [ApplicationIntegrationType.GuildInstall],
      });
    }
  });
});

describe('loadEvents', () => {
  it('registers every event, and a once event only once', async () => {
    await fixture(
      'events/debug.ts',
      `export default { name: 'debug', execute: (context, message) => { context.logger.info({ message }, 'debug ran'); } };\n`,
    );
    await fixture(
      'events/ready.js',
      `export default { name: 'clientReady', once: true, execute: (context) => { context.logger.info('ready ran'); } };\n`,
    );
    const { logger, lines } = captureLogs();
    const emitter = newClient();

    const names = await loadEvents(emitter, fakeContext({ logger }), join(root, 'events'));
    emitter.emit(Events.Debug, 'one');
    emitter.emit(Events.Debug, 'two');
    emitter.emit(Events.ClientReady, emitter as Client<true>);
    emitter.emit(Events.ClientReady, emitter as Client<true>);
    await flush();

    expect(names).toEqual(['debug', 'clientReady']);
    expect(lines.map((line) => line.msg)).toEqual(['debug ran', 'debug ran', 'ready ran']);
    expect(lines[1]).toMatchObject({ message: 'two' });
  });

  it.each([
    ['throws', `() => { throw new Error('event broke'); }`],
    ['rejects', `async () => { throw new Error('event broke'); }`],
  ])('logs an event that %s instead of letting the error escape', async (_case, execute) => {
    const file = await fixture(
      'events/broken.ts',
      `export default { name: 'debug', execute: ${execute} };\n`,
    );
    const { logger, lines } = captureLogs();
    const emitter = newClient();
    await loadEvents(emitter, fakeContext({ logger }), join(root, 'events'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      expect(() => emitter.emit(Events.Debug, 'go')).not.toThrow();
      await flush();
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(lines).toEqual([
      expect.objectContaining({
        level: 50,
        msg: 'event failed',
        event: 'debug',
        file,
        err: expect.objectContaining({ message: 'event broke' }) as unknown,
      }),
    ]);
  });

  it('rejects a module that is not an event, naming the file', async () => {
    const bad = await fixture('events/broken.ts', `export default { execute: () => {} };\n`);

    await expect(loadEvents(newClient(), fakeContext(), join(root, 'events'))).rejects.toThrow(
      `${bad}: the default export is not an event`,
    );
  });

  it("loads the bot's own events", async () => {
    const emitter = newClient();

    const names = await loadEvents(emitter, fakeContext());

    expect([...names].sort()).toEqual(['clientReady', 'error', 'interactionCreate']);
    expect(emitter.listenerCount(Events.InteractionCreate)).toBe(1);
    expect(emitter.listenerCount(Events.Error)).toBe(1);
  });
});
