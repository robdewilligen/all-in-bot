import { Client, GatewayIntentBits } from 'discord.js';
import { Cooldowns } from './bot/cooldowns.js';
import { loggableError } from './bot/errors.js';
import { loadCommands, loadEvents } from './bot/loader.js';
import { shutDown } from './bot/shutdown.js';
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
  const tables = new TableRegistry();
  const refunds = new TableRefunds(wallet, logger);
  // `once`: a second Ctrl+C gets Node's default and ends the process right away.
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    void shutDown({ tables, refunds, client, pool, logger }).then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const context: AppContext = {
    wallet,
    logger,
    clock: () => Temporal.Now.instant(),
    cooldowns: new Cooldowns(),
    tables,
    refunds,
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
