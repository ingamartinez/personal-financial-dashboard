CREATE TYPE "public"."reconciliation_status" AS ENUM('unreconciled', 'matched', 'flagged', 'imported_from_statement');--> statement-breakpoint
ALTER TYPE "public"."tx_source" ADD VALUE 'csv_reconcile';--> statement-breakpoint
CREATE TABLE "reconciliation_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"txn_id" integer NOT NULL,
	"action" varchar(32) NOT NULL,
	"merged_into_txn_id" integer,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "reconciliation_decisions_action_check" CHECK ("reconciliation_decisions"."action" IN ('archived', 'kept', 'merged_into'))
);
--> statement-breakpoint
CREATE TABLE "statement_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"txn_count" integer DEFAULT 0 NOT NULL,
	"balance_at_end_cents" bigint
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "reconciliation_status" "reconciliation_status" DEFAULT 'unreconciled' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "statement_import_id" integer;--> statement-breakpoint
ALTER TABLE "reconciliation_decisions" ADD CONSTRAINT "reconciliation_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_decisions" ADD CONSTRAINT "reconciliation_decisions_txn_id_transactions_id_fk" FOREIGN KEY ("txn_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_decisions" ADD CONSTRAINT "reconciliation_decisions_merged_into_txn_id_transactions_id_fk" FOREIGN KEY ("merged_into_txn_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_decisions_user_decided_idx" ON "reconciliation_decisions" USING btree ("user_id","decided_at");--> statement-breakpoint
CREATE INDEX "reconciliation_decisions_txn_idx" ON "reconciliation_decisions" USING btree ("txn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_imports_user_account_file_unique" ON "statement_imports" USING btree ("user_id","account_id","file_hash");--> statement-breakpoint
CREATE INDEX "statement_imports_account_period_idx" ON "statement_imports" USING btree ("account_id","period_start","period_end");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_statement_import_id_statement_imports_id_fk" FOREIGN KEY ("statement_import_id") REFERENCES "public"."statement_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_account_recon_idx" ON "transactions" USING btree ("account_id","reconciliation_status","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_flagged_idx" ON "transactions" USING btree ("user_id","occurred_at") WHERE "transactions"."reconciliation_status" = 'flagged';