import type { Logger } from '../../core/logger.js';
import { TableRoundClosedError, type Wallet } from '../../core/wallet.js';
import { loggableError } from '../errors.js';

/**
 * What became of a table round's stakes:
 * - `refunded`: the coins are back;
 * - `pending`: the database failed, and the refund is retried in the background;
 * - `settled`: the round was settled after all, for instance when the answer to that got lost.
 */
export type RefundResult = 'refunded' | 'pending' | 'settled';

/** Waits between retries; the last one repeats until the refund goes through. */
export const REFUND_RETRY_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000];

/**
 * Refunds table rounds that no settlement will close (SPEC §10). A failed refund is retried until
 * it goes through, so the round's players can play that game again without a restart: until
 * then, their open round blocks a new one.
 */
export class TableRefunds {
  readonly #wallet: Pick<Wallet, 'refundTableRound'>;
  readonly #logger: Logger;
  readonly #delays: readonly number[];
  readonly #timers = new Set<NodeJS.Timeout>();
  #stopped = false;

  constructor(
    wallet: Pick<Wallet, 'refundTableRound'>,
    logger: Logger,
    delays: readonly number[] = REFUND_RETRY_MS,
  ) {
    if (delays.length === 0) throw new RangeError('TableRefunds needs at least one retry delay');
    this.#wallet = wallet;
    this.#logger = logger;
    this.#delays = delays;
  }

  /** Refunds now; on a database failure the retries start and this returns `pending`. */
  async refund(tableRoundId: number, logger: Logger = this.#logger): Promise<RefundResult> {
    const result = await this.#attempt(tableRoundId, logger);
    if (result !== null) return result;
    this.#retry(tableRoundId, logger, 0);
    return 'pending';
  }

  /** Shutdown: no more retries. The startup refund returns whatever is still open. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Never rejects: null means the database failed and the refund should be tried again. */
  async #attempt(tableRoundId: number, logger: Logger): Promise<'refunded' | 'settled' | null> {
    try {
      await this.#wallet.refundTableRound(tableRoundId);
      return 'refunded';
    } catch (error) {
      if (error instanceof TableRoundClosedError) return error.status;
      logger.error({ tableRoundId, err: loggableError(error) }, 'could not refund a table round');
      return null;
    }
  }

  #retry(tableRoundId: number, logger: Logger, attempt: number): void {
    if (this.#stopped) return;
    const delay = this.#delays[Math.min(attempt, this.#delays.length - 1)] ?? 0;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#stopped) return;
      void this.#attempt(tableRoundId, logger).then((result) => {
        if (result === null) {
          this.#retry(tableRoundId, logger, attempt + 1);
          return;
        }
        logger.info({ tableRoundId, retries: attempt + 1, result }, 'refunded a table round');
      });
    }, delay);
    // A pending retry never keeps the process alive; the startup refund covers it.
    timer.unref();
    this.#timers.add(timer);
  }
}
