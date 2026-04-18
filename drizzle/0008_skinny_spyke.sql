ALTER TYPE "public"."tx_source" ADD VALUE 'telegram';--> statement-breakpoint
CREATE TABLE "telegram_poll_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_update_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_sessions" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
