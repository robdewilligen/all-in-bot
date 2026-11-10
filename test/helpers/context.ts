import pino from 'pino';
import { vi, type Mock } from 'vitest';
import { TableRefunds } from '../../src/bot/tables/refunds.js';
import { TableRegistry } from '../../src/bot/tables/registry.js';
import type { AppContext } from '../../src/bot/types.js';
import type { Logger } from '../../src/core/logger.js';
import type { Wallet } from '../../src/core/wallet.js';
import { fakeHosts, type FakeHosts } from './tables.js';

export type FakeWallet = Wallet & { readonly [K in keyof Wallet]: Mock<Wallet[K]> };

/** 2026-11-09 13:00 in Amsterdam. */
export const FIXED_NOW = Temporal.Instant.from('2026-11-09T12:00:00Z');

function unexpected<K extends keyof Wallet>(name: K): Mock<Wallet[K]> {
  return vi.fn(() =>
    Promise.reject(new Error(`unexpected call: wallet.${name}`)),
  ) as unknown as Mock<Wallet[K]>;
}

/** A wallet whose methods reject until a test gives them a result; touchPlayer just resolves. */
export function fakeWallet(): FakeWallet {
  return {
    touchPlayer: vi.fn<Wallet['touchPlayer']>(() => Promise.resolve()),
    balanceOf: unexpected('balanceOf'),
    standingOf: unexpected('standingOf'),
    leaderboard: unexpected('leaderboard'),
    claimDaily: unexpected('claimDaily'),
    claimFirstGift: unexpected('claimFirstGift'),
    playInstant: unexpected('playInstant'),
    openTableRound: unexpected('openTableRound'),
    openRound: unexpected('openRound'),
    raiseRound: unexpected('raiseRound'),
    settleTableRound: unexpected('settleTableRound'),
    refundTableRound: unexpected('refundTableRound'),
    refundOpenRounds: unexpected('refundOpenRounds'),
  } as FakeWallet;
}

export interface FakeContext extends AppContext {
  readonly wallet: FakeWallet;
  readonly hosts: FakeHosts;
}

/** The boot ID of fake registries: table IDs are `t-1`, `t-2`… */
export const BOOT_ID = 't';

/**
 * A context with a fake wallet, a silent logger, a fixed clock and no cooldowns.
 * - Its refunds use that wallet and retry after REFUND_RETRY_MS, so a test with fake timers can
 *   run the retries.
 * - Its hosts are fakeHosts(); a TableHost test builds its context with the real ones.
 */
export function fakeContext(
  overrides: Partial<Omit<AppContext, 'wallet' | 'hosts'>> = {},
): FakeContext {
  const wallet = fakeWallet();
  const logger = overrides.logger ?? pino({ level: 'silent' });
  return {
    wallet,
    logger,
    clock: () => FIXED_NOW,
    cooldowns: { hit: () => null },
    tables: new TableRegistry(BOOT_ID),
    refunds: new TableRefunds(wallet, logger),
    hosts: fakeHosts(),
    ...overrides,
  };
}

export interface LogCapture {
  readonly logger: Logger;
  /** Every line the logger wrote, parsed; pino levels are numbers (40 warn, 50 error). */
  readonly lines: Record<string, unknown>[];
}

/** A logger that keeps what it writes, so a test can check the serialized log lines. */
export function captureLogs(): LogCapture {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'trace' },
    {
      write(line: string): void {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}
