CREATE TYPE "public"."email_receipt_gateway" AS ENUM('mercado_pago', 'payu', 'wompi', 'apple', 'paypal', 'bancolombia');--> statement-breakpoint
CREATE TYPE "public"."email_receipt_match_status" AS ENUM('pending', 'matched', 'ambiguous', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."gmail_connection_status" AS ENUM('active', 'expired', 'revoked', 'error');--> statement-breakpoint
ALTER TYPE "public"."tx_source" ADD VALUE 'gmail_bancolombia';--> statement-breakpoint
ALTER TYPE "public"."tx_source" ADD VALUE 'gmail_enrichment';--> statement-breakpoint
CREATE TABLE "email_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"gmail_connection_id" integer NOT NULL,
	"gmail_msg_id" varchar(64) NOT NULL,
	"gateway" "email_receipt_gateway" NOT NULL,
	"merchant" varchar(200),
	"amount_cents" bigint,
	"currency" "currency",
	"occurred_at" timestamp with time zone,
	"reference_id" varchar(120),
	"raw_html" text NOT NULL,
	"parsed_payload" jsonb,
	"matched_transaction_id" integer,
	"match_status" "email_receipt_match_status" DEFAULT 'pending' NOT NULL,
	"match_candidates" jsonb,
	"parsed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"gmail_email" varchar(320) NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text[] NOT NULL,
	"last_pull_at" timestamp with time zone,
	"last_pull_history_id" text,
	"status" "gmail_connection_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "enriched_merchant" varchar(200);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "enrichment_source" varchar(40);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_mismatch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source_mismatch_details" jsonb;--> statement-breakpoint
ALTER TABLE "email_receipts" ADD CONSTRAINT "email_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_receipts" ADD CONSTRAINT "email_receipts_gmail_connection_id_gmail_connections_id_fk" FOREIGN KEY ("gmail_connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_receipts" ADD CONSTRAINT "email_receipts_matched_transaction_id_transactions_id_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_receipts_user_msg_unique" ON "email_receipts" USING btree ("user_id","gmail_msg_id") WHERE "email_receipts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "email_receipts_user_status_idx" ON "email_receipts" USING btree ("user_id","match_status") WHERE "email_receipts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "email_receipts_match_lookup_idx" ON "email_receipts" USING btree ("user_id","amount_cents","occurred_at") WHERE "email_receipts"."match_status" = 'pending' AND "email_receipts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "email_receipts_connection_idx" ON "email_receipts" USING btree ("gmail_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_connections_user_email_unique" ON "gmail_connections" USING btree ("user_id","gmail_email") WHERE "gmail_connections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "gmail_connections_user_status_idx" ON "gmail_connections" USING btree ("user_id","status") WHERE "gmail_connections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "gmail_connections_active_idx" ON "gmail_connections" USING btree ("last_pull_at") WHERE "gmail_connections"."status" = 'active' AND "gmail_connections"."deleted_at" IS NULL;