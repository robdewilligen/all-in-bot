import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PlayerError } from '../../src/core/errors.js';
import { TableRoundClosedError } from '../../src/core/wallet.js';
import { ledgerEntries, players, rounds, tableRounds } from '../../src/db/schema.js';
import {
  GUILD,
  OTHER_GUILD,
  ledgerMismatches,
  openTestDatabase,
  player,
  seed,
  truncateAll,
} from './helpers.js';

const { pool, db, wallet } = openTestDatabase();

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

/** 2026-11-09 13:00 in Amsterdam; the next reset is midnight, 23:00 UTC. */
const NOW = Temporal.Instant.from('2026-11-09T12:00:00Z');
const later = (days: number): Temporal.Instant => NOW.add({ hours: 24 * days });

async function balances(): Promise<Record<string, number>> {
  const rows = await db
    .select({ userId: players.userId, balance: players.balance })
    .from(players)
    .orderBy(asc(players.userId));
  return Object.fromEntries(rows.map((row) => [row.userId, row.balance]));
}

async function ledgerCount(): Promise<number> {
  return db.$count(ledgerEntries);
}

async function waitForSessionsWaitingOnLocks(count: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await db.execute(sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (Number(result.rows[0]?.waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${String(count)} sessions waiting on a lock`);
}

/** The rejection's message plus its cause's: Drizzle wraps database errors as the cause. */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error('expected the promise to reject with an Error');
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return `${error.message}\n${cause}`;
}

async function expectRejectsWith(promise: Promise<unknown>, key: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PlayerError);
  expect((error as PlayerError).userMessage[0]).toBe(key);
}

describe('players', () => {
  it('creates a row on the first command and refreshes the display name later', async () => {
    const alice = player(1);
    await wallet.touchPlayer(alice);
    await wallet.touchPlayer({ ...alice, displayName: 'Alice the Bold' });
    const rows = await db.select().from(players);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ displayName: 'Alice the Bold', balance: 0 });
  });

  it("doesn't create a row when someone looks up a player who never played", async () => {
    expect(await wallet.standingOf(player(9))).toEqual({ balance: 0, rank: null });
    expect(await wallet.balanceOf(player(9))).toBe(0);
    expect(await db.$count(players)).toBe(0);
  });
});

describe('the daily gift', () => {
  it('gives 100 coins on the first claim, with the next reset at midnight in Amsterdam', async () => {
    const claim = await wallet.claimDaily(player(1), NOW);
    expect(claim).toEqual({
      status: 'claimed',
      amount: 100,
      streak: 1,
      balance: 100,
      nextReset: Temporal.Instant.from('2026-11-09T23:00:00Z'),
    });
  });

  it('refuses a second claim on the same day and keeps the balance', async () => {
    await wallet.claimDaily(player(1), NOW);
    const second = await wallet.claimDaily(player(1), NOW.add({ hours: 10 }));
    expect(second).toEqual({
      status: 'alreadyClaimed',
      nextReset: Temporal.Instant.from('2026-11-09T23:00:00Z'),
    });
    expect(await wallet.balanceOf(player(1))).toBe(100);
  });

  it('adds 10 per consecutive day up to 170 and resets after a missed day', async () => {
    const amounts: number[] = [];
    for (let day = 0; day < 9; day += 1) {
      const claim = await wallet.claimDaily(player(1), later(day));
      if (claim.status !== 'claimed') throw new Error(`day ${String(day)} was not claimed`);
      amounts.push(claim.amount);
    }
    expect(amounts).toEqual([100, 110, 120, 130, 140, 150, 160, 170, 170]);
    const afterGap = await wallet.claimDaily(player(1), later(10));
    expect(afterGap).toMatchObject({ status: 'claimed', amount: 100, streak: 1 });
    expect(await wallet.balanceOf(player(1))).toBe(1_350);
  });

  it('starts a new day at midnight in Amsterdam, not in UTC', async () => {
    const lateEvening = Temporal.Instant.from('2026-11-09T22:30:00Z');
    const afterMidnight = Temporal.Instant.from('2026-11-09T23:30:00Z');
    expect(await wallet.claimDaily(player(1), lateEvening)).toMatchObject({ status: 'claimed' });
    expect(await wallet.claimDaily(player(1), afterMidnight)).toMatchObject({
      status: 'claimed',
      streak: 2,
    });
  });

  it('lets exactly one of many concurrent claims for the same day succeed', async () => {
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => wallet.claimDaily(player(1), NOW)),
    );
    expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
    expect(await wallet.balanceOf(player(1))).toBe(100);
    expect(await ledgerCount()).toBe(1);
  });
});

describe('the first gift', () => {
  it('gives 1,000 once per server, also to a player who already has coins', async () => {
    await seed(db, player(1), 500);

    expect(await wallet.claimFirstGift(player(1))).toEqual({
      status: 'claimed',
      amount: 1_000,
      balance: 1_500,
    });
    expect(await wallet.claimFirstGift(player(1))).toEqual({ status: 'alreadyClaimed' });
    expect(await wallet.balanceOf(player(1))).toBe(1_500);
    expect(await wallet.claimFirstGift(player(1, OTHER_GUILD))).toEqual({
      status: 'claimed',
      amount: 1_000,
      balance: 1_000,
    });

    const entries = await db
      .select({
        kind: ledgerEntries.kind,
        roundId: ledgerEntries.roundId,
        amount: ledgerEntries.amount,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.kind, 'first_gift'));
    expect(entries).toEqual([
      { kind: 'first_gift', roundId: null, amount: 1_000 },
      { kind: 'first_gift', roundId: null, amount: 1_000 },
    ]);
    expect(await ledgerMismatches(db)).toEqual([]);
  });

  it('lets exactly one of many concurrent claims through', async () => {
    await seed(db, player(1), 0);
    // A share lock on the player holds every claim at its first write until all have got there.
    const holder = await pool.connect();
    let claims: PromiseSettledResult<unknown>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM players WHERE guild_id = $1 AND user_id = $2 FOR SHARE', [
        GUILD,
        player(1).userId,
      ]);
      const pending = Promise.allSettled(
        Array.from({ length: 5 }, () => wallet.claimFirstGift(player(1))),
      );
      await waitForSessionsWaitingOnLocks(5);
      await holder.query('COMMIT');
      claims = await pending;
    } finally {
      holder.release();
    }

    expect(claims.map((claim) => claim.status)).toEqual(
      Array.from({ length: 5 }, () => 'fulfilled'),
    );
    const values = claims.map((claim) => (claim.status === 'fulfilled' ? claim.value : null));
    expect(
      values.filter((value) => (value as { status: string }).status === 'claimed'),
    ).toHaveLength(1);
    expect(await wallet.balanceOf(player(1))).toBe(1_000);
    expect(await ledgerCount()).toBe(1);
  });

  it('keeps the ledger rule that only gifts come without a round', async () => {
    await wallet.claimFirstGift(player(1));
    const rejected = db.insert(ledgerEntries).values({
      guildId: GUILD,
      userId: player(1).userId,
      roundId: null,
      kind: 'stake',
      amount: -10,
      balanceAfter: 990,
    });
    expect(await rejectionText(rejected)).toMatch(/ledger_entries_round_unless_gift/);
  });
});

describe('ranks and the leaderboard', () => {
  it('gives equal balances the same rank and orders them by user ID', async () => {
    await seed(db, player(4), 300);
    await seed(db, player(2), 300);
    await seed(db, player(1), 500);
    await seed(db, player(3), 100);
    await seed(db, player(5), 0);
    const board = await wallet.leaderboard(GUILD, 1);
    expect(board.entries.map((entry) => [entry.rank, entry.userId])).toEqual([
      [1, player(1).userId],
      [2, player(2).userId],
      [2, player(4).userId],
      [4, player(3).userId],
    ]);
    expect(board).toMatchObject({ page: 1, pageCount: 1, playerCount: 4 });
    expect(await wallet.standingOf(player(4))).toEqual({ balance: 300, rank: 2 });
    expect(await wallet.standingOf(player(3))).toEqual({ balance: 100, rank: 4 });
    expect(await wallet.standingOf(player(5))).toEqual({ balance: 0, rank: null });
  });

  it('shows pages of 10 and clamps a page beyond either end', async () => {
    for (let n = 1; n <= 25; n += 1) await seed(db, player(n), n * 10);
    const last = await wallet.leaderboard(GUILD, 99);
    expect(last).toMatchObject({ page: 3, pageCount: 3, playerCount: 25 });
    expect(last.entries.map((entry) => entry.rank)).toEqual([21, 22, 23, 24, 25]);
    const first = await wallet.leaderboard(GUILD, 0);
    expect(first.page).toBe(1);
    expect(first.entries).toHaveLength(10);
    expect(first.entries[0]).toMatchObject({ rank: 1, balance: 250, displayName: 'Player 25' });
  });

  it('counts only ranked players of this server', async () => {
    await seed(db, player(1), 100);
    await seed(db, player(2, OTHER_GUILD), 900);
    expect(await wallet.leaderboard(GUILD, 1)).toMatchObject({ playerCount: 1 });
    expect(await wallet.standingOf(player(1))).toEqual({ balance: 100, rank: 1 });
    expect(await wallet.leaderboard('100000000000000009', 1)).toEqual({
      entries: [],
      page: 1,
      pageCount: 1,
      playerCount: 0,
    });
  });
});

describe('instant games', () => {
  it('debits the stake, credits the payout and records both in the ledger', async () => {
    await seed(db, player(1), 1_000);
    const result = await wallet.playInstant(player(1), 'slots', 100, () => ({
      payout: 250,
      details: { reels: ['🍒', '🍒', '🍋'] },
    }));
    expect(result).toMatchObject({ stake: 100, payout: 250, balance: 1_150 });
    const [round] = await db.select().from(rounds);
    expect(round).toMatchObject({ game: 'slots', status: 'settled', stake: 100, payout: 250 });
    expect(await ledgerMismatches(db)).toEqual([]);
  });

  it('refuses a stake above the balance and changes nothing', async () => {
    await seed(db, player(1), 50);
    await expectRejectsWith(
      wallet.playInstant(player(1), 'slots', 100, () => ({ payout: 0, details: null })),
      'errors.insufficientFunds',
    );
    expect(await wallet.balanceOf(player(1))).toBe(50);
    expect(await db.$count(rounds)).toBe(0);
  });

  it('rolls back completely when the game throws', async () => {
    await seed(db, player(1), 1_000);
    await expect(
      wallet.playInstant(player(1), 'slots', 100, () => {
        throw new Error('reel jammed');
      }),
    ).rejects.toThrow('reel jammed');
    expect(await wallet.balanceOf(player(1))).toBe(1_000);
    expect(await db.$count(rounds)).toBe(0);
    expect(await ledgerCount()).toBe(1);
  });

  it('lets exactly 10 of 50 parallel stakes of 100 through on a balance of 1,000', async () => {
    await seed(db, player(1), 1_000);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        wallet.playInstant(player(1), 'slots', 100, () => ({ payout: 0, details: null })),
      ),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    expect(results.length - failures.length).toBe(10);
    for (const failure of failures) expect(failure.reason).toBeInstanceOf(PlayerError);
    expect(await wallet.balanceOf(player(1))).toBe(0);
    expect(await ledgerMismatches(db)).toEqual([]);
  });
});

describe('table rounds', () => {
  async function seatedTable(stakes: readonly number[]): Promise<{
    tableRoundId: number;
    roundIds: number[];
  }> {
    const tableRoundId = await wallet.openTableRound(GUILD, 'roulette');
    const roundIds: number[] = [];
    for (const [index, stake] of stakes.entries()) {
      await seed(db, player(index + 1), 1_000);
      roundIds.push((await wallet.openRound(player(index + 1), tableRoundId, stake)).roundId);
    }
    return { tableRoundId, roundIds };
  }

  it('reserves stakes, takes raises and settles every player with one outcome', async () => {
    const { tableRoundId, roundIds } = await seatedTable([100, 200]);
    const [first = 0, second = 0] = roundIds;
    expect(await wallet.raiseRound(first, 50)).toEqual({
      roundId: first,
      stake: 150,
      balance: 850,
    });
    const settled = await wallet.settleTableRound(tableRoundId, { number: 17 }, [
      { roundId: first, payout: 300, details: { won: true } },
      { roundId: second, payout: 0 },
    ]);
    expect(settled).toEqual([
      { roundId: first, userId: player(1).userId, stake: 150, payout: 300, balance: 1_150 },
      { roundId: second, userId: player(2).userId, stake: 200, payout: 0, balance: 800 },
    ]);
    const [table] = await db.select().from(tableRounds);
    expect(table).toMatchObject({ status: 'settled', outcome: { number: 17 } });
    expect(await db.$count(rounds, eq(rounds.status, 'open'))).toBe(0);
    expect(await ledgerMismatches(db)).toEqual([]);
  });

  it("doesn't let a player hold two open rounds of one game in one server", async () => {
    await seatedTable([100]);
    const secondTable = await wallet.openTableRound(GUILD, 'roulette');
    await expect(wallet.openRound(player(1), secondTable, 100)).rejects.toThrow();
    expect(await wallet.balanceOf(player(1))).toBe(900);
    expect(await db.$count(rounds, eq(rounds.status, 'open'))).toBe(1);
    const blackjack = await wallet.openTableRound(GUILD, 'blackjack');
    await expect(wallet.openRound(player(1), blackjack, 100)).resolves.toMatchObject({
      balance: 800,
    });
  });

  it('refuses a raise above the balance and keeps the stake', async () => {
    const { roundIds } = await seatedTable([900]);
    const [round = 0] = roundIds;
    await expectRejectsWith(wallet.raiseRound(round, 200), 'errors.insufficientFunds');
    const [row] = await db.select({ stake: rounds.stake }).from(rounds);
    expect(row?.stake).toBe(900);
    expect(await wallet.balanceOf(player(1))).toBe(100);
  });

  it('settles four players atomically: a failure rolls every one of them back', async () => {
    const { tableRoundId, roundIds } = await seatedTable([100, 100, 100, 100]);
    const ledgerBefore = await ledgerCount();
    // The last player in settlement order (highest user ID) gets details that can't be stored.
    const settlements = roundIds.map((roundId, index) => ({
      roundId,
      payout: 200,
      details: index === 3 ? { unstorable: 1n } : null,
    }));
    expect(await rejectionText(wallet.settleTableRound(tableRoundId, null, settlements))).toMatch(
      /BigInt/,
    );
    expect(Object.values(await balances())).toEqual([900, 900, 900, 900]);
    expect(await db.$count(rounds, eq(rounds.status, 'open'))).toBe(4);
    const [table] = await db.select({ status: tableRounds.status }).from(tableRounds);
    expect(table?.status).toBe('open');
    expect(await ledgerCount()).toBe(ledgerBefore);
  });

  it('needs exactly one settlement for each open round', async () => {
    const { tableRoundId, roundIds } = await seatedTable([100, 100]);
    const [first = 0] = roundIds;
    await expect(
      wallet.settleTableRound(tableRoundId, null, [{ roundId: first, payout: 200 }]),
    ).rejects.toThrow(/exactly one settlement/);
    expect(Object.values(await balances())).toEqual([900, 900]);
  });

  it("can't be settled twice or joined after settling", async () => {
    const { tableRoundId, roundIds } = await seatedTable([100]);
    const settlements = roundIds.map((roundId) => ({ roundId, payout: 0 }));
    await wallet.settleTableRound(tableRoundId, null, settlements);
    await expect(wallet.settleTableRound(tableRoundId, null, settlements)).rejects.toThrow(
      /settled/,
    );
    await seed(db, player(7), 500);
    await expect(wallet.openRound(player(7), tableRoundId, 100)).rejects.toThrow(/not open/);
    expect(await wallet.balanceOf(player(7))).toBe(500);
  });

  it('lets one of two parallel raises at two tables through when the balance covers one', async () => {
    await seed(db, player(1), 1_000);
    const roulette = await wallet.openTableRound(GUILD, 'roulette');
    const blackjack = await wallet.openTableRound(GUILD, 'blackjack');
    const first = await wallet.openRound(player(1), roulette, 100);
    const second = await wallet.openRound(player(1), blackjack, 100);
    // Different rounds lock different rows, so only the conditional debit stands between them.
    // A share lock on the player holds both raises at their debit until both have got there, so
    // they really overlap instead of running one after the other.
    const holder = await pool.connect();
    let results: PromiseSettledResult<unknown>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM players WHERE guild_id = $1 AND user_id = $2 FOR SHARE', [
        GUILD,
        player(1).userId,
      ]);
      const raises = Promise.allSettled([
        wallet.raiseRound(first.roundId, 800),
        wallet.raiseRound(second.roundId, 800),
      ]);
      await waitForSessionsWaitingOnLocks(2);
      await holder.query('COMMIT');
      results = await raises;
    } finally {
      holder.release();
    }
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.reason).toBeInstanceOf(PlayerError);
    expect(await wallet.balanceOf(player(1))).toBe(0);
    expect(await ledgerMismatches(db)).toEqual([]);
  });

  it('refunds one failed table round and lets its players play that game again', async () => {
    const { tableRoundId } = await seatedTable([100, 300]);
    const otherTable = await wallet.openTableRound(GUILD, 'roulette');
    await seed(db, player(5), 1_000);
    await wallet.openRound(player(5), otherTable, 200);
    expect(await wallet.refundTableRound(tableRoundId)).toEqual({
      rounds: 2,
      tableRounds: 1,
      coins: 400,
    });
    expect(await balances()).toEqual({
      [player(1).userId]: 1_000,
      [player(2).userId]: 1_000,
      [player(5).userId]: 800,
    });
    await expect(wallet.refundTableRound(tableRoundId)).rejects.toMatchObject({
      name: 'TableRoundClosedError',
      status: 'refunded',
    });
    const nextTable = await wallet.openTableRound(GUILD, 'roulette');
    await expect(wallet.openRound(player(1), nextTable, 100)).resolves.toMatchObject({
      balance: 900,
    });
    expect(await ledgerMismatches(db)).toEqual([]);
  });

  it('tells a table whose settlement answer got lost that the round was settled', async () => {
    const { tableRoundId, roundIds } = await seatedTable([100]);
    const [roundId = 0] = roundIds;
    await wallet.settleTableRound(tableRoundId, { number: 7 }, [{ roundId, payout: 0 }]);

    const refund = wallet.refundTableRound(tableRoundId);
    await expect(refund).rejects.toBeInstanceOf(TableRoundClosedError);
    await expect(refund).rejects.toMatchObject({ tableRoundId, status: 'settled' });
    await expect(
      wallet.settleTableRound(tableRoundId, { number: 7 }, [{ roundId, payout: 0 }]),
    ).rejects.toMatchObject({ status: 'settled' });
    expect(await wallet.balanceOf(player(1))).toBe(900);
  });

  it('refunds at startup an open round whose table round already closed', async () => {
    const { tableRoundId } = await seatedTable([100]);
    await db.update(tableRounds).set({ status: 'settled' }).where(eq(tableRounds.id, tableRoundId));
    expect(await wallet.refundOpenRounds()).toEqual({ rounds: 1, tableRounds: 0, coins: 100 });
    expect(await wallet.balanceOf(player(1))).toBe(1_000);
  });

  it('refunds open rounds exactly once, even when two refunds run at the same time', async () => {
    const { roundIds } = await seatedTable([100, 250, 400]);
    const [first = 0] = roundIds;
    await wallet.raiseRound(first, 50);
    const [one, two] = await Promise.all([wallet.refundOpenRounds(), wallet.refundOpenRounds()]);
    expect(one.rounds + two.rounds).toBe(3);
    expect(one.coins + two.coins).toBe(800);
    expect(Object.values(await balances())).toEqual([1_000, 1_000, 1_000]);
    expect(await wallet.refundOpenRounds()).toEqual({ rounds: 0, tableRounds: 0, coins: 0 });
    const [table] = await db.select({ status: tableRounds.status }).from(tableRounds);
    expect(table?.status).toBe('refunded');
    expect(await ledgerMismatches(db)).toEqual([]);
  });
});

describe('the ledger', () => {
  it('rejects changes and deletions', async () => {
    await wallet.claimDaily(player(1), NOW);
    expect(await rejectionText(db.update(ledgerEntries).set({ amount: 5 }).execute())).toMatch(
      /append-only: UPDATE/,
    );
    expect(await rejectionText(db.delete(ledgerEntries).execute())).toMatch(/append-only: DELETE/);
    expect(await ledgerCount()).toBe(1);
  });

  it('adds up to every balance after a mix of games, gifts, raises and refunds', async () => {
    await wallet.claimDaily(player(1), NOW);
    await wallet.claimDaily(player(2), NOW);
    await wallet.claimFirstGift(player(1));
    await wallet.claimFirstGift(player(2));
    await wallet.playInstant(player(1), 'slots', 300, () => ({ payout: 900, details: null }));
    const table = await wallet.openTableRound(GUILD, 'blackjack');
    const { roundId } = await wallet.openRound(player(2), table, 200);
    await wallet.raiseRound(roundId, 200);
    await wallet.openRound(player(1), table, 100);
    await wallet.refundOpenRounds();
    await wallet.claimDaily(player(1), later(1));
    // Alice: 100 + 1,000 + 600 from slots + 110 on day 2; Bob: 100 + 1,000, his stakes refunded.
    expect(await balances()).toEqual({ [player(1).userId]: 1_810, [player(2).userId]: 1_100 });
    expect(await ledgerMismatches(db)).toEqual([]);
  });
});
