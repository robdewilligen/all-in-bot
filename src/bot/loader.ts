import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Collection, type Client, type ClientEvents } from 'discord.js';
import { loggableError } from './errors.js';
import type { AppContext, Command } from './types.js';

const COMMANDS_DIRECTORY = fileURLToPath(new URL('../commands/', import.meta.url));
const EVENTS_DIRECTORY = fileURLToPath(new URL('../events/', import.meta.url));

interface LoadedEvent {
  readonly name: keyof ClientEvents;
  readonly once?: boolean;
  execute(context: AppContext, ...args: unknown[]): Promise<void> | void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCommand(value: unknown): value is Command {
  if (!isObject(value) || !isObject(value.data)) return false;
  const { data, execute, autocomplete, cooldown } = value;
  return (
    typeof data.name === 'string' &&
    typeof data.toJSON === 'function' &&
    typeof execute === 'function' &&
    (autocomplete === undefined || typeof autocomplete === 'function') &&
    (cooldown === undefined || (typeof cooldown === 'number' && cooldown >= 0))
  );
}

function isEvent(value: unknown): value is LoadedEvent {
  return (
    isObject(value) &&
    typeof value.name === 'string' &&
    typeof value.execute === 'function' &&
    (value.once === undefined || typeof value.once === 'boolean')
  );
}

function isModuleFile(name: string): boolean {
  return (name.endsWith('.ts') || name.endsWith('.js')) && !name.endsWith('.d.ts');
}

async function entriesOf(directory: string, kind: 'file' | 'directory'): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) =>
      kind === 'directory' ? entry.isDirectory() : entry.isFile() && isModuleFile(entry.name),
    )
    .map((entry) => join(directory, entry.name))
    .sort();
}

async function defaultExportOf(file: string): Promise<unknown> {
  try {
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
    return module.default;
  } catch (error) {
    throw new Error(`${file}: the module failed to load`, { cause: error });
  }
}

/** Every command in <directory>/<group>/, by name. */
export async function loadCommands(
  directory: string = COMMANDS_DIRECTORY,
): Promise<Collection<string, Command>> {
  const commands = new Collection<string, Command>();
  const files = new Map<string, string>();
  for (const group of await entriesOf(directory, 'directory')) {
    for (const file of await entriesOf(group, 'file')) {
      const command = await defaultExportOf(file);
      if (!isCommand(command)) {
        throw new Error(
          `${file}: the default export is not a command (it needs data.name, data.toJSON() and execute())`,
        );
      }
      const name = command.data.name;
      const earlier = files.get(name);
      if (earlier !== undefined) {
        throw new Error(`${file}: the command name "${name}" is already used by ${earlier}`);
      }
      files.set(name, file);
      commands.set(name, command);
    }
  }
  return commands;
}

async function run(
  event: LoadedEvent,
  context: AppContext,
  file: string,
  args: unknown[],
): Promise<void> {
  try {
    await event.execute(context, ...args);
  } catch (error) {
    context.logger.error({ err: loggableError(error), event: event.name, file }, 'event failed');
  }
}

/** Registers every event in <directory>; a failing event is logged instead of rejecting. */
export async function loadEvents(
  client: Client,
  context: AppContext,
  directory: string = EVENTS_DIRECTORY,
): Promise<(keyof ClientEvents)[]> {
  const names: (keyof ClientEvents)[] = [];
  for (const file of await entriesOf(directory, 'file')) {
    const event = await defaultExportOf(file);
    if (!isEvent(event)) {
      throw new Error(`${file}: the default export is not an event (it needs name and execute())`);
    }
    const listener = (...args: unknown[]): void => {
      void run(event, context, file, args);
    };
    if (event.once === true) client.once(event.name, listener);
    else client.on(event.name, listener);
    names.push(event.name);
  }
  return names;
}
