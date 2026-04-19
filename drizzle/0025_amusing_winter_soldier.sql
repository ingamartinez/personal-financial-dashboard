CREATE TYPE "public"."tx_channel" AS ENUM('bank', 'manual', 'transfer');--> statement-breakpoint
ALTER TYPE "public"."tx_source" ADD VALUE 'balance_adjustment';--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "channel" "tx_channel" DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "is_adjustment" boolean DEFAULT false NOT NULL;