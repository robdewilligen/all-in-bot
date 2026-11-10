ALTER TYPE "public"."ledger_kind" ADD VALUE 'first_gift';--> statement-breakpoint
CREATE TABLE "first_gifts" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "first_gifts_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id"),
	CONSTRAINT "first_gifts_amount_positive" CHECK ("first_gifts"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_round_unless_daily";--> statement-breakpoint
ALTER TABLE "first_gifts" ADD CONSTRAINT "first_gifts_guild_id_user_id_players_guild_id_user_id_fk" FOREIGN KEY ("guild_id","user_id") REFERENCES "public"."players"("guild_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_round_unless_gift" CHECK (("ledger_entries"."kind"::text IN ('daily', 'first_gift')) = ("ledger_entries"."round_id" IS NULL));