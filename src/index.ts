import { Client, GatewayIntentBits } from 'discord.js';
import type pg from 'pg';
import { Cooldowns } from './bot/cooldowns.js';
import { loggableError } from './bot/errors.js';
import { loadCommands, loadEvents } from './bot/loader.js';
import { TableRefunds } from './bot/tables/refunds.js';
import { TableRegistry } from './bot/tables/registry.js';
import { createTableHosts } from './bot/tables/table.js';
import type { AppContext } from './bot/types.js';
import { botEnvSchema, EnvError, parseEnv } from './config/env.js';
import { logger } from './core/logger.js';
import { createTableNumbers } from './core/table-numbers.js';
import { createWallet } from './core/wallet.js';
import { BOT_TIMEOUTS, createDatabase, createPool } from './db/client.js';

process.on('unhandledRejection', (reason) => {
  logger.error({ err: loggableError(reason) }, 'unhandled promise rejection');
});

async function stop(client: Client, pool: pg.Pool): Promise<void> {
  try {
    await client.destroy();
  } catch (error) {
    logger.error({ err: loggableError(error) }, 'closing the Discord client failed');
  }
  try {
    await pool.end();
  } catch (error) {
    logger.error({ err: loggableError(error) }, 'closing the database pool failed');
  }
  process.exit(0);
}

async function start(): Promise<void> {
  const env = parseEnv(botEnvSchema);
  logger.level = env.LOG_LEVEL;

  const pool = createPool(env.DATABASE_URL, BOT_TIMEOUTS);
  const db = createDatabase(pool);
  const wallet = createWallet(db, { timeZone: env.DAILY_RESET_TIMEZONE });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
  });
  const shutDown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    void stop(client, pool);
  };
  process.once('SIGINT', shutDown);
  process.once('SIGTERM', shutDown);

  const context: AppContext = {
    wallet,
    logger,
    clock: () => Temporal.Now.instant(),
    cooldowns: new Cooldowns(),
    tables: new TableRegistry(),
    refunds: new TableRefunds(wallet, logger),
    hosts: createTableHosts(createTableNumbers(db)),
  };
  client.commands = await loadCommands();
  const events = await loadEvents(client, context);
  logger.info({ commands: [...client.commands.keys()], events }, 'loaded commands and events');

  logger.info(await wallet.refundOpenRounds(), 'refunded open rounds');
  await client.login(env.DISCORD_TOKEN);
}

try {
  await start();
} catch (error) {
  if (error instanceof EnvError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    logger.fatal({ err: loggableError(error) }, 'the bot could not start');
    process.exit(1);
  }
}
