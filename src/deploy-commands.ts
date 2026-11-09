import { REST, Routes } from 'discord.js';
import { loggableError } from './bot/errors.js';
import { loadCommands } from './bot/loader.js';
import type { Command } from './bot/types.js';
import { discordEnvSchema, EnvError, parseEnv, type DiscordEnv } from './config/env.js';
import { logger } from './core/logger.js';

/** Replaces the registered slash commands: in DEV_GUILD_ID when set (instant), otherwise globally. */
export async function deployCommands(
  rest: Pick<REST, 'put'>,
  env: Pick<DiscordEnv, 'DISCORD_CLIENT_ID' | 'DEV_GUILD_ID'>,
  commands: Iterable<Command>,
): Promise<void> {
  const body = Array.from(commands, (command) => command.data.toJSON());
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

async function main(): Promise<void> {
  const env = parseEnv(discordEnvSchema);
  const commands = await loadCommands();
  await deployCommands(new REST().setToken(env.DISCORD_TOKEN), env, commands.values());
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof EnvError) console.error(error.message);
    else logger.error({ err: loggableError(error) }, 'registering the commands failed');
    process.exitCode = 1;
  }
}
