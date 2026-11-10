import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Kept free of local imports: drizzle-kit loads this file on its own.

/** A bigint column read as a JS number; values outside the safe-integer range are an error. */
const coins = customType<{ data: number; driverData: string | number }>({
  dataType: () => 'bigint',
  fromDriver: (value) => {
    const amount = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(amount)) {
      throw new RangeError(`Coin value ${String(value)} is not a safe integer`);
    }
    return amount;
  },
  toDriver: (value) => value,
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const game = pgEnum('game', ['roulette', 'blackjack', 'slots']);
export const roundStatus = pgEnum('round_status', ['open', 'settled', 'refunded']);
export const ledgerKind = pgEnum('ledger_kind', [
  'daily',
  'stake',
  'raise',
  'payout',
  'refund',
  'first_gift',
]);

export const players = pgTable(
  'players',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    balance: coins('balance').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    check('players_balance_not_negative', sql`${table.balance} >= 0`),
    // NULLS FIRST is what a plain ORDER BY balance DESC means, so the leaderboard can use this.
    index('players_leaderboard_idx').on(
      table.guildId,
      table.balance.desc().nullsFirst(),
      table.userId,
    ),
  ],
);

export const dailyClaims = pgTable(
  'daily_claims',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    claimDate: date('claim_date', { mode: 'string' }).notNull(),
    amount: coins('amount').notNull(),
    streak: integer('streak').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.claimDate] }),
    foreignKey({
      columns: [table.guildId, table.userId],
      foreignColumns: [players.guildId, players.userId],
    }),
    check('daily_claims_amount_positive', sql`${table.amount} > 0`),
    check('daily_claims_streak_positive', sql`${table.streak} >= 1`),
  ],
);

export const tableRounds = pgTable(
  'table_rounds',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
    game: game('game').notNull(),
    status: roundStatus('status').notNull().default('open'),
    outcome: jsonb('outcome'),
    createdAt: createdAt(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    check('table_rounds_table_game', sql`${table.game} <> 'slots'`),
    index('table_rounds_open_idx')
      .on(table.id)
      .where(sql`${table.status} = 'open'`),
  ],
);

export const rounds = pgTable(
  'rounds',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    game: game('game').notNull(),
    tableRoundId: bigint('table_round_id', { mode: 'number' }).references(() => tableRounds.id),
    status: roundStatus('status').notNull().default('open'),
    stake: coins('stake').notNull(),
    payout: coins('payout'),
    details: jsonb('details'),
    createdAt: createdAt(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.guildId, table.userId],
      foreignColumns: [players.guildId, players.userId],
    }),
    check('rounds_stake_positive', sql`${table.stake} > 0`),
    check('rounds_payout_not_negative', sql`${table.payout} >= 0`),
    check('rounds_payout_once_closed', sql`(${table.status} = 'open') = (${table.payout} IS NULL)`),
    check(
      'rounds_table_round_for_table_games',
      sql`(${table.game} = 'slots') = (${table.tableRoundId} IS NULL)`,
    ),
    uniqueIndex('rounds_one_open_per_game')
      .on(table.guildId, table.userId, table.game)
      .where(sql`${table.status} = 'open'`),
    index('rounds_table_round_idx').on(table.tableRoundId),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    roundId: bigint('round_id', { mode: 'number' }).references(() => rounds.id),
    kind: ledgerKind('kind').notNull(),
    amount: coins('amount').notNull(),
    balanceAfter: coins('balance_after').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.guildId, table.userId],
      foreignColumns: [players.guildId, players.userId],
    }),
    check(
      'ledger_entries_amount_sign',
      sql`${table.amount} <> 0 AND (${table.kind} IN ('stake', 'raise')) = (${table.amount} < 0)`,
    ),
    // Compared as text: PostgreSQL refuses an enum value in the transaction that added it.
    check(
      'ledger_entries_round_unless_gift',
      sql`(${table.kind}::text IN ('daily', 'first_gift')) = (${table.roundId} IS NULL)`,
    ),
    check('ledger_entries_balance_after_not_negative', sql`${table.balanceAfter} >= 0`),
    index('ledger_entries_player_idx').on(table.guildId, table.userId, table.createdAt),
  ],
);

/** The one-time head start per player per server (SPEC §5); the key makes a claim idempotent. */
export const firstGifts = pgTable(
  'first_gifts',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    amount: coins('amount').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    foreignKey({
      columns: [table.guildId, table.userId],
      foreignColumns: [players.guildId, players.userId],
    }),
    check('first_gifts_amount_positive', sql`${table.amount} > 0`),
  ],
);

/** The last table number per server, for thread names like "Table #12" (SPEC §4). Not money. */
export const guildTableCounters = pgTable('guild_table_counters', {
  guildId: text('guild_id').primaryKey(),
  lastNumber: integer('last_number').notNull(),
});
