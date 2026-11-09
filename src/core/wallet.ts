import { and, asc, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { gameConfig } from '../config/game.js';
import type { Database } from '../db/client.js';
import { dailyClaims, ledgerEntries, players, rounds, tableRounds } from '../db/schema.js';
import { formatCoins } from '../i18n/format.js';
import { PlayerError } from './errors.js';
import { dayOf, nextResetAfter } from './time.js';

export type Game = 'roulette' | 'blackjack' | 'slots';
export type TableGame = Exclude<Game, 'slots'>;
export type InstantGame = 'slots';

export interface PlayerRef {
  readonly guildId: string;
  readonly userId: string;
}

export interface PlayerIdentity extends PlayerRef {
  readonly displayName: string;
}

/** Balance plus leaderboard rank; rank is null for an unranked player (balance 0 or never played). */
export interface Standing {
  readonly balance: number;
  readonly rank: number | null;
}

export interface LeaderboardEntry {
  readonly rank: number;
  readonly userId: string;
  readonly displayName: string;
  readonly balance: number;
}

/** One page of ranked players. `page` is clamped to 1..pageCount, and pageCount is at least 1. */
export interface LeaderboardPage {
  readonly entries: readonly LeaderboardEntry[];
  readonly page: number;
  readonly pageCount: number;
  readonly playerCount: number;
}

export type DailyClaim =
  | {
      readonly status: 'claimed';
      readonly amount: number;
      readonly streak: number;
      readonly balance: number;
      readonly nextReset: Temporal.Instant;
    }
  | { readonly status: 'alreadyClaimed'; readonly nextReset: Temporal.Instant };

export interface InstantPlay<Details> {
  readonly payout: number;
  readonly details: Details;
}

export interface InstantResult<Details> {
  readonly roundId: number;
  readonly stake: number;
  readonly payout: number;
  readonly balance: number;
  readonly details: Details;
}

export interface OpenedRound {
  readonly roundId: number;
  readonly stake: number;
  readonly balance: number;
}

/** `stake` is the round's new total stake. */
export interface RaisedRound {
  readonly roundId: number;
  readonly stake: number;
  readonly balance: number;
}

export interface RoundSettlement {
  readonly roundId: number;
  readonly payout: number;
  readonly details?: unknown;
}

export interface SettledRound {
  readonly roundId: number;
  readonly userId: string;
  readonly stake: number;
  readonly payout: number;
  readonly balance: number;
}

export interface RefundSummary {
  readonly rounds: number;
  readonly tableRounds: number;
  readonly coins: number;
}

/**
 * Every coin movement. Each method that moves coins runs in one transaction and appends ledger
 * entries; a debit throws PlayerError('errors.insufficientFunds') when the balance is too low.
 */
export interface Wallet {
  /** Creates the player's row or refreshes their display name; runs before every command. */
  touchPlayer(player: PlayerIdentity): Promise<void>;
  balanceOf(player: PlayerRef): Promise<number>;
  standingOf(player: PlayerRef): Promise<Standing>;
  leaderboard(guildId: string, page: number): Promise<LeaderboardPage>;
  claimDaily(player: PlayerIdentity, now: Temporal.Instant): Promise<DailyClaim>;
  playInstant<Details>(
    player: PlayerIdentity,
    game: InstantGame,
    stake: number,
    play: () => InstantPlay<Details>,
  ): Promise<InstantResult<Details>>;
  openTableRound(guildId: string, game: TableGame): Promise<number>;
  openRound(player: PlayerIdentity, tableRoundId: number, stake: number): Promise<OpenedRound>;
  raiseRound(roundId: number, amount: number): Promise<RaisedRound>;
  settleTableRound(
    tableRoundId: number,
    outcome: unknown,
    settlements: readonly RoundSettlement[],
  ): Promise<SettledRound[]>;
  /** Refunds one open table round, e.g. after its settlement failed, so its players can play on. */
  refundTableRound(tableRoundId: number): Promise<RefundSummary>;
  /** Refunds every open round; only at startup, before the bot takes interactions. */
  refundOpenRounds(): Promise<RefundSummary>;
}

export interface WalletOptions {
  /** IANA zone whose midnight starts a new daily-gift day. */
  readonly timeZone: string;
}

/** The app database or a transaction on it. */
type Executor = PgDatabase<NodePgQueryResultHKT>;

function assertStake(amount: number, what: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError(`${what} must be a positive whole number of coins, got ${String(amount)}`);
  }
}

function assertPayout(payout: number): void {
  if (!Number.isSafeInteger(payout) || payout < 0) {
    throw new RangeError(`A payout must be a whole number of coins ≥ 0, got ${String(payout)}`);
  }
}

function single<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`${what} not found`);
  return row;
}

function isPlayer(player: PlayerRef) {
  return and(eq(players.guildId, player.guildId), eq(players.userId, player.userId));
}

async function upsertPlayer(db: Executor, player: PlayerIdentity): Promise<void> {
  await db
    .insert(players)
    .values({ guildId: player.guildId, userId: player.userId, displayName: player.displayName })
    .onConflictDoUpdate({
      target: [players.guildId, players.userId],
      set: { displayName: player.displayName, updatedAt: sql`now()` },
      setWhere: sql`${players.displayName} IS DISTINCT FROM ${player.displayName}`,
    });
}

async function balanceIn(db: Executor, player: PlayerRef): Promise<number> {
  const [row] = await db.select({ balance: players.balance }).from(players).where(isPlayer(player));
  return row?.balance ?? 0;
}

/** Conditional and atomic, so concurrent stakes can never overspend (CLAUDE.md money rules). */
async function debit(db: Executor, player: PlayerRef, amount: number): Promise<number> {
  const [row] = await db
    .update(players)
    .set({ balance: sql`${players.balance} - ${amount}`, updatedAt: sql`now()` })
    .where(and(isPlayer(player), gte(players.balance, amount)))
    .returning({ balance: players.balance });
  if (row !== undefined) return row.balance;
  const balance = await balanceIn(db, player);
  throw new PlayerError('errors.insufficientFunds', {
    needed: formatCoins(amount),
    balance: formatCoins(balance),
  });
}

async function credit(db: Executor, player: PlayerRef, amount: number): Promise<number> {
  const rows = await db
    .update(players)
    .set({ balance: sql`${players.balance} + ${amount}`, updatedAt: sql`now()` })
    .where(isPlayer(player))
    .returning({ balance: players.balance });
  return single(rows, `player ${player.guildId}/${player.userId}`).balance;
}

const openRoundColumns = {
  id: rounds.id,
  guildId: rounds.guildId,
  userId: rounds.userId,
  stake: rounds.stake,
};

interface OpenRound {
  readonly id: number;
  readonly guildId: string;
  readonly userId: string;
  readonly stake: number;
}

/** Gives every round its stake back, with a ledger entry each, and returns the total. */
async function refundRounds(db: Executor, open: readonly OpenRound[]): Promise<number> {
  let coins = 0;
  for (const round of open) {
    const balance = await credit(db, round, round.stake);
    await db.insert(ledgerEntries).values({
      guildId: round.guildId,
      userId: round.userId,
      roundId: round.id,
      kind: 'refund',
      amount: round.stake,
      balanceAfter: balance,
    });
    await db
      .update(rounds)
      .set({ status: 'refunded', payout: round.stake, settledAt: sql`now()` })
      .where(eq(rounds.id, round.id));
    coins += round.stake;
  }
  return coins;
}

// Several reads that must agree, such as a count and the page it clamps.
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

export function createWallet(db: Database, options: WalletOptions): Wallet {
  const { timeZone } = options;
  const { daily, leaderboard } = gameConfig;

  return {
    async touchPlayer(player) {
      await upsertPlayer(db, player);
    },

    balanceOf: (player) => balanceIn(db, player),

    standingOf(player) {
      return db.transaction(async (tx) => {
        const balance = await balanceIn(tx, player);
        if (balance === 0) return { balance, rank: null };
        const ahead = await tx.$count(
          players,
          and(eq(players.guildId, player.guildId), gt(players.balance, balance)),
        );
        return { balance, rank: ahead + 1 };
      }, snapshot);
    },

    leaderboard(guildId, page) {
      return db.transaction(async (tx) => {
        const ranked = and(eq(players.guildId, guildId), gt(players.balance, 0));
        const playerCount = await tx.$count(players, ranked);
        const pageCount = Math.max(1, Math.ceil(playerCount / leaderboard.pageSize));
        const requested = Number.isFinite(page) ? Math.trunc(page) : 1;
        const current = Math.min(Math.max(requested, 1), pageCount);
        const entries = await tx
          .select({
            rank: sql<number>`rank() over (order by ${players.balance} desc)`.mapWith(Number),
            userId: players.userId,
            displayName: players.displayName,
            balance: players.balance,
          })
          .from(players)
          .where(ranked)
          .orderBy(desc(players.balance), asc(players.userId))
          .limit(leaderboard.pageSize)
          .offset((current - 1) * leaderboard.pageSize);
        return { entries, page: current, pageCount, playerCount };
      }, snapshot);
    },

    claimDaily(player, now) {
      const today = dayOf(now, timeZone);
      const nextReset = nextResetAfter(now, timeZone);
      return db.transaction(async (tx) => {
        await upsertPlayer(tx, player);
        const [last] = await tx
          .select({ claimDate: dailyClaims.claimDate, streak: dailyClaims.streak })
          .from(dailyClaims)
          .where(
            and(eq(dailyClaims.guildId, player.guildId), eq(dailyClaims.userId, player.userId)),
          )
          .orderBy(desc(dailyClaims.claimDate))
          .limit(1);
        if (last?.claimDate === today.toString()) return { status: 'alreadyClaimed', nextReset };
        const yesterday = today.subtract({ days: 1 }).toString();
        const streak = last?.claimDate === yesterday ? last.streak + 1 : 1;
        const amount =
          daily.base + Math.min(daily.streakBonus * (streak - 1), daily.maxStreakBonus);
        // The upsert above locked the player's row, so claims run one at a time; the key is a backstop.
        const inserted = await tx
          .insert(dailyClaims)
          .values({
            guildId: player.guildId,
            userId: player.userId,
            claimDate: today.toString(),
            amount,
            streak,
          })
          .onConflictDoNothing()
          .returning({ streak: dailyClaims.streak });
        if (inserted.length === 0) return { status: 'alreadyClaimed', nextReset };
        const balance = await credit(tx, player, amount);
        await tx.insert(ledgerEntries).values({
          guildId: player.guildId,
          userId: player.userId,
          kind: 'daily',
          amount,
          balanceAfter: balance,
        });
        return { status: 'claimed', amount, streak, balance, nextReset };
      });
    },

    playInstant(player, game, stake, play) {
      assertStake(stake, 'A stake');
      return db.transaction(async (tx) => {
        await upsertPlayer(tx, player);
        const afterStake = await debit(tx, player, stake);
        const { payout, details } = play();
        assertPayout(payout);
        const round = single(
          await tx
            .insert(rounds)
            .values({
              guildId: player.guildId,
              userId: player.userId,
              game,
              status: 'settled',
              stake,
              payout,
              details,
              settledAt: sql`now()`,
            })
            .returning({ id: rounds.id }),
          'new round',
        );
        const entry = { guildId: player.guildId, userId: player.userId, roundId: round.id };
        await tx
          .insert(ledgerEntries)
          .values({ ...entry, kind: 'stake', amount: -stake, balanceAfter: afterStake });
        let balance = afterStake;
        if (payout > 0) {
          balance = await credit(tx, player, payout);
          await tx
            .insert(ledgerEntries)
            .values({ ...entry, kind: 'payout', amount: payout, balanceAfter: balance });
        }
        return { roundId: round.id, stake, payout, balance, details };
      });
    },

    async openTableRound(guildId, game) {
      const rows = await db
        .insert(tableRounds)
        .values({ guildId, game })
        .returning({ id: tableRounds.id });
      return single(rows, 'new table round').id;
    },

    openRound(player, tableRoundId, stake) {
      assertStake(stake, 'A stake');
      return db.transaction(async (tx) => {
        // A share lock waits for a settlement in progress, so no round joins a settled table.
        const table = single(
          await tx
            .select({
              guildId: tableRounds.guildId,
              game: tableRounds.game,
              status: tableRounds.status,
            })
            .from(tableRounds)
            .where(eq(tableRounds.id, tableRoundId))
            .for('share'),
          `table round ${String(tableRoundId)}`,
        );
        if (table.status !== 'open' || table.guildId !== player.guildId) {
          throw new Error(`table round ${String(tableRoundId)} is not open in this server`);
        }
        await upsertPlayer(tx, player);
        const balance = await debit(tx, player, stake);
        const round = single(
          await tx
            .insert(rounds)
            .values({
              guildId: player.guildId,
              userId: player.userId,
              game: table.game,
              tableRoundId,
              stake,
            })
            .returning({ id: rounds.id }),
          'new round',
        );
        await tx.insert(ledgerEntries).values({
          guildId: player.guildId,
          userId: player.userId,
          roundId: round.id,
          kind: 'stake',
          amount: -stake,
          balanceAfter: balance,
        });
        return { roundId: round.id, stake, balance };
      });
    },

    raiseRound(roundId, amount) {
      assertStake(amount, 'A raise');
      return db.transaction(async (tx) => {
        const round = single(
          await tx
            .select({ guildId: rounds.guildId, userId: rounds.userId, status: rounds.status })
            .from(rounds)
            .where(eq(rounds.id, roundId))
            .for('update'),
          `round ${String(roundId)}`,
        );
        if (round.status !== 'open') throw new Error(`round ${String(roundId)} is ${round.status}`);
        const balance = await debit(tx, round, amount);
        const { stake } = single(
          await tx
            .update(rounds)
            .set({ stake: sql`${rounds.stake} + ${amount}` })
            .where(eq(rounds.id, roundId))
            .returning({ stake: rounds.stake }),
          `round ${String(roundId)}`,
        );
        await tx.insert(ledgerEntries).values({
          guildId: round.guildId,
          userId: round.userId,
          roundId,
          kind: 'raise',
          amount: -amount,
          balanceAfter: balance,
        });
        return { roundId, stake, balance };
      });
    },

    settleTableRound(tableRoundId, outcome, settlements) {
      return db.transaction(async (tx) => {
        const table = single(
          await tx
            .select({ status: tableRounds.status })
            .from(tableRounds)
            .where(eq(tableRounds.id, tableRoundId))
            .for('update'),
          `table round ${String(tableRoundId)}`,
        );
        if (table.status !== 'open') {
          throw new Error(`table round ${String(tableRoundId)} is ${table.status}`);
        }
        const open = await tx
          .select({
            id: rounds.id,
            guildId: rounds.guildId,
            userId: rounds.userId,
            stake: rounds.stake,
          })
          .from(rounds)
          .where(and(eq(rounds.tableRoundId, tableRoundId), eq(rounds.status, 'open')))
          // Players are credited in a fixed order, so two tables settling at once can't deadlock.
          .orderBy(asc(rounds.userId))
          .for('update');
        const byRound = new Map(settlements.map((settlement) => [settlement.roundId, settlement]));
        if (byRound.size !== settlements.length || byRound.size !== open.length) {
          throw new Error(
            `table round ${String(tableRoundId)} has ${String(open.length)} open rounds; each needs exactly one settlement`,
          );
        }
        const settled: SettledRound[] = [];
        for (const round of open) {
          const settlement = byRound.get(round.id);
          if (settlement === undefined) {
            throw new Error(`round ${String(round.id)} has no settlement`);
          }
          const { payout } = settlement;
          assertPayout(payout);
          let balance: number;
          if (payout > 0) {
            balance = await credit(tx, round, payout);
            await tx.insert(ledgerEntries).values({
              guildId: round.guildId,
              userId: round.userId,
              roundId: round.id,
              kind: 'payout',
              amount: payout,
              balanceAfter: balance,
            });
          } else {
            balance = await balanceIn(tx, round);
          }
          await tx
            .update(rounds)
            .set({
              status: 'settled',
              payout,
              details: settlement.details ?? null,
              settledAt: sql`now()`,
            })
            .where(eq(rounds.id, round.id));
          settled.push({
            roundId: round.id,
            userId: round.userId,
            stake: round.stake,
            payout,
            balance,
          });
        }
        await tx
          .update(tableRounds)
          .set({ status: 'settled', outcome: outcome ?? null, settledAt: sql`now()` })
          .where(eq(tableRounds.id, tableRoundId));
        return settled;
      });
    },

    refundTableRound(tableRoundId) {
      return db.transaction(async (tx) => {
        const table = single(
          await tx
            .select({ status: tableRounds.status })
            .from(tableRounds)
            .where(eq(tableRounds.id, tableRoundId))
            .for('update'),
          `table round ${String(tableRoundId)}`,
        );
        if (table.status !== 'open') {
          throw new Error(`table round ${String(tableRoundId)} is ${table.status}`);
        }
        const open = await tx
          .select(openRoundColumns)
          .from(rounds)
          .where(and(eq(rounds.tableRoundId, tableRoundId), eq(rounds.status, 'open')))
          .orderBy(asc(rounds.userId))
          .for('update');
        const coins = await refundRounds(tx, open);
        await tx
          .update(tableRounds)
          .set({ status: 'refunded', settledAt: sql`now()` })
          .where(eq(tableRounds.id, tableRoundId));
        return { rounds: open.length, tableRounds: 1, coins };
      });
    },

    refundOpenRounds() {
      return db.transaction(async (tx) => {
        // Table rounds first, the order settle and openRound lock in, so they can't deadlock.
        const tables = await tx
          .select({ id: tableRounds.id })
          .from(tableRounds)
          .where(eq(tableRounds.status, 'open'))
          .orderBy(asc(tableRounds.id))
          .for('update');
        // Every open round, also one whose table round already closed. Rows a concurrent refund
        // locked are skipped once it commits, so each round is refunded once.
        const open = await tx
          .select(openRoundColumns)
          .from(rounds)
          .where(eq(rounds.status, 'open'))
          .orderBy(asc(rounds.guildId), asc(rounds.userId))
          .for('update');
        const coins = await refundRounds(tx, open);
        if (tables.length > 0) {
          await tx
            .update(tableRounds)
            .set({ status: 'refunded', settledAt: sql`now()` })
            .where(
              inArray(
                tableRounds.id,
                tables.map((table) => table.id),
              ),
            );
        }
        return { rounds: open.length, tableRounds: tables.length, coins };
      });
    },
  };
}
