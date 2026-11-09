CREATE TYPE "public"."game" AS ENUM('roulette', 'blackjack', 'slots');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('daily', 'stake', 'raise', 'payout', 'refund');--> statement-breakpoint
CREATE TYPE "public"."round_status" AS ENUM('open', 'settled', 'refunded');--> statement-breakpoint
CREATE TABLE "daily_claims" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"claim_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"streak" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_claims_guild_id_user_id_claim_date_pk" PRIMARY KEY("guild_id","user_id","claim_date"),
	CONSTRAINT "daily_claims_amount_positive" CHECK ("daily_claims"."amount" > 0),
	CONSTRAINT "daily_claims_streak_positive" CHECK ("daily_claims"."streak" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"round_id" bigint,
	"kind" "ledger_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_sign" CHECK ("ledger_entries"."amount" <> 0 AND ("ledger_entries"."kind" IN ('stake', 'raise')) = ("ledger_entries"."amount" < 0)),
	CONSTRAINT "ledger_entries_round_unless_daily" CHECK (("ledger_entries"."kind" = 'daily') = ("ledger_entries"."round_id" IS NULL)),
	CONSTRAINT "ledger_entries_balance_after_not_negative" CHECK ("ledger_entries"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "players" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id"),
	CONSTRAINT "players_balance_not_negative" CHECK ("players"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rounds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"game" "game" NOT NULL,
	"table_round_id" bigint,
	"status" "round_status" DEFAULT 'open' NOT NULL,
	"stake" bigint NOT NULL,
	"payout" bigint,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "rounds_stake_positive" CHECK ("rounds"."stake" > 0),
	CONSTRAINT "rounds_payout_not_negative" CHECK ("rounds"."payout" >= 0),
	CONSTRAINT "rounds_payout_once_closed" CHECK (("rounds"."status" = 'open') = ("rounds"."payout" IS NULL)),
	CONSTRAINT "rounds_table_round_for_table_games" CHECK (("rounds"."game" = 'slots') = ("rounds"."table_round_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "table_rounds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "table_rounds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"game" "game" NOT NULL,
	"status" "round_status" DEFAULT 'open' NOT NULL,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "table_rounds_table_game" CHECK ("table_rounds"."game" <> 'slots')
);
--> statement-breakpoint
ALTER TABLE "daily_claims" ADD CONSTRAINT "daily_claims_guild_id_user_id_players_guild_id_user_id_fk" FOREIGN KEY ("guild_id","user_id") REFERENCES "public"."players"("guild_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_guild_id_user_id_players_guild_id_user_id_fk" FOREIGN KEY ("guild_id","user_id") REFERENCES "public"."players"("guild_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_table_round_id_table_rounds_id_fk" FOREIGN KEY ("table_round_id") REFERENCES "public"."table_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_guild_id_user_id_players_guild_id_user_id_fk" FOREIGN KEY ("guild_id","user_id") REFERENCES "public"."players"("guild_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_player_idx" ON "ledger_entries" USING btree ("guild_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "players_leaderboard_idx" ON "players" USING btree ("guild_id","balance" DESC NULLS FIRST,"user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_one_open_per_game" ON "rounds" USING btree ("guild_id","user_id","game") WHERE "rounds"."status" = 'open';--> statement-breakpoint
CREATE INDEX "rounds_table_round_idx" ON "rounds" USING btree ("table_round_id");--> statement-breakpoint
CREATE INDEX "table_rounds_open_idx" ON "table_rounds" USING btree ("id") WHERE "table_rounds"."status" = 'open';