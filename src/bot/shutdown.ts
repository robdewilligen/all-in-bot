import type { Logger } from '../core/logger.js';
import { loggableError } from './errors.js';
import type { TableRefunds } from './tables/refunds.js';
import type { TableRegistry } from './tables/registry.js';

export interface RunningBot {
  readonly tables: Pick<TableRegistry, 'closeAll'>;
  readonly refunds: Pick<TableRefunds, 'stop'>;
  readonly client: { destroy(): Promise<void> };
  readonly pool: { end(): Promise<void> };
  readonly logger: Logger;
}

/**
 * Stops the bot cleanly (SPEC §13 phase 6): first the tables, while the client can still edit their
 * messages, then the client, then the pool. Open rounds stay open and are refunded at the next
 * startup. Never throws: every failure is logged and the rest still runs.
 */
export async function shutDown(bot: RunningBot): Promise<void> {
  const { logger } = bot;
  try {
    for (const failure of await bot.tables.closeAll()) {
      logger.error({ err: loggableError(failure) }, 'closing a table failed');
    }
  } catch (error) {
    logger.error({ err: loggableError(error) }, 'closing the tables failed');
  }
  // Before the pool ends; the startup refund returns what the retries didn't.
  bot.refunds.stop();
  try {
    await bot.client.destroy();
  } catch (error) {
    logger.error({ err: loggableError(error) }, 'closing the Discord client failed');
  }
  try {
    await bot.pool.end();
  } catch (error) {
    logger.error({ err: loggableError(error) }, 'closing the database pool failed');
  }
}
