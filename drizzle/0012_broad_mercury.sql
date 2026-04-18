-- Multi-tenancy phase 1 (#183): add user_id to every tenant-scoped table.
-- Strategy: NOT NULL DEFAULT 1 backfills existing rows with the bootstrap
-- user's id (= 1) in-place, eliminating the NULL window. The temporary
-- default is dropped in PR 3 once every INSERT supplies an explicit user_id.
--
-- telegram_sessions.user_id (bigint, the Telegram API's user id) is renamed
-- to telegram_user_id; a new user_id integer FK is added alongside it.
-- RENAME preserves data that a DATA TYPE cast would risk truncating.

ALTER TABLE "telegram_sessions" RENAME COLUMN "user_id" TO "telegram_user_id";--> statement-breakpoint
ALTER TABLE "telegram_sessions" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_snapshots" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "classification_rules" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "counterparties" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "counterparty_aliases" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_logs" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "insights_reports" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_gaps" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "user_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_rules" ADD CONSTRAINT "classification_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_aliases" ADD CONSTRAINT "counterparty_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_logs" ADD CONSTRAINT "ingestion_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_reports" ADD CONSTRAINT "insights_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_gaps" ADD CONSTRAINT "recurring_gaps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_sessions" ADD CONSTRAINT "telegram_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
