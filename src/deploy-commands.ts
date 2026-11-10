import {
  REST,
  Routes,
  type Collection,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { loggableError } from './bot/errors.js';
import { loadCommands } from './bot/loader.js';
import type { Command } from './bot/types.js';
import { discordEnvSchema, EnvError, parseEnv, type DiscordEnv } from './config/env.js';
import { logger } from './core/logger.js';

/** Prints the definitions instead of registering them; needs no token. */
export const PRINT_FLAG = '--print';

function commandBodies(
  commands: Iterable<Command>,
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return Array.from(commands, (command) => command.data.toJSON());
}

/**
 * The request body that deployCommands sends, as one line of JSON. The same definitions always give
 * the same text, so the setup can hash it to see whether they changed since the last registration.
 */
export function commandDefinitions(commands: Iterable<Command>): string {
  return JSON.stringify(commandBodies(commands));
}

/** Replaces the registered slash commands: in DEV_GUILD_ID when set (instant), otherwise globally. */
export async function deployCommands(
  rest: Pick<REST, 'put'>,
  env: Pick<DiscordEnv, 'DISCORD_CLIENT_ID' | 'DEV_GUILD_ID'>,
  commands: Iterable<Command>,
): Promise<void> {
  const body = commandBodies(commands);
  const guildId = env.DEV_GUILD_ID;
  if (guildId === undefined) {
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
    logger.info({ count: body.length }, `registered ${body.length} commands globally`);
  } else {
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), { body });
    logger.info(
      { count: body.length, guildId },
      `registered ${body.length} commands in server ${guildId}`,
    );
  }
}

/** With PRINT_FLAG, writes the definitions to stdout; otherwise registers them through REST. */
export async function main(
  args: readonly string[],
  load: () => Promise<Collection<string, Command>> = () => loadCommands(),
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): Promise<void> {
  if (args.includes(PRINT_FLAG)) {
    const commands = await load();
    write(`${commandDefinitions(commands.values())}\n`);
    return;
  }
  const env = parseEnv(discordEnvSchema);
  const commands = await load();
  await deployCommands(new REST().setToken(env.DISCORD_TOKEN), env, commands.values());
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof EnvError) console.error(error.message);
    else logger.error({ err: loggableError(error) }, 'registering the commands failed');
    process.exitCode = 1;
  }
}
