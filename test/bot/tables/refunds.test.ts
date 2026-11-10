import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUND_RETRY_MS, TableRefunds } from '../../../src/bot/tables/refunds.js';
import {
  TableRoundClosedError,
  type RefundSummary,
  type Wallet,
} from '../../../src/core/wallet.js';
import { captureLogs } from '../../helpers/context.js';

const REFUNDED: RefundSummary = { rounds: 2, tableRounds: 1, coins: 300 };

function wallet(): { refundTableRound: ReturnType<typeof vi.fn<Wallet['refundTableRound']>> } {
  return { refundTableRound: vi.fn<Wallet['refundTableRound']>() };
}

describe('TableRefunds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refunds at once when the database takes it', async () => {
    const fake = wallet();
    fake.refundTableRound.mockResolvedValue(REFUNDED);
    const refunds = new TableRefunds(fake, captureLogs().logger);

    await expect(refunds.refund(7)).resolves.toBe('refunded');

    expect(fake.refundTableRound.mock.calls).toEqual([[7]]);
    await vi.advanceTimersByTimeAsync(REFUND_RETRY_MS[0] ?? 0);
    expect(fake.refundTableRound).toHaveBeenCalledTimes(1);
  });

  it('reports a round that was settled after all, and leaves it alone', async () => {
    const fake = wallet();
    fake.refundTableRound.mockRejectedValue(new TableRoundClosedError(7, 'settled'));
    const refunds = new TableRefunds(fake, captureLogs().logger);

    await expect(refunds.refund(7)).resolves.toBe('settled');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(fake.refundTableRound).toHaveBeenCalledTimes(1);
  });

  it('counts a round that something else refunded already as refunded', async () => {
    const fake = wallet();
    fake.refundTableRound.mockRejectedValue(new TableRoundClosedError(7, 'refunded'));
    const refunds = new TableRefunds(fake, captureLogs().logger);

    await expect(refunds.refund(7)).resolves.toBe('refunded');
  });

  it('keeps retrying a failed refund until the database takes it, so the players can play again', async () => {
    const fake = wallet();
    fake.refundTableRound
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(REFUNDED);
    const { logger, lines } = captureLogs();
    const refunds = new TableRefunds(fake, logger, [1_000, 5_000]);

    await expect(refunds.refund(7)).resolves.toBe('pending');
    expect(fake.refundTableRound).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fake.refundTableRound).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.refundTableRound).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.refundTableRound).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.refundTableRound).toHaveBeenCalledTimes(3);

    expect(lines.filter((line) => line.level === 50)).toHaveLength(2);
    expect(lines.filter((line) => line.msg === 'refunded a table round')).toEqual([
      expect.objectContaining({ tableRoundId: 7, retries: 2, result: 'refunded' }),
    ]);
  });

  it('repeats the last wait once the list runs out', async () => {
    const fake = wallet();
    fake.refundTableRound.mockRejectedValue(new Error('down'));
    const refunds = new TableRefunds(fake, captureLogs().logger, [1_000, 5_000]);

    await refunds.refund(7);
    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 5_000 + 5_000);

    expect(fake.refundTableRound).toHaveBeenCalledTimes(5);
  });

  it('stops retrying at shutdown; the startup refund returns what is left', async () => {
    const fake = wallet();
    fake.refundTableRound.mockRejectedValue(new Error('down'));
    const refunds = new TableRefunds(fake, captureLogs().logger, [1_000]);

    await refunds.refund(7);
    refunds.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(refunds.refund(8)).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fake.refundTableRound.mock.calls).toEqual([[7], [8]]);
  });

  it('uses the waits of the spec: 5 s, 30 s, 2 min, then every 10 min', () => {
    expect(REFUND_RETRY_MS).toEqual([5_000, 30_000, 120_000, 600_000]);
  });
});
