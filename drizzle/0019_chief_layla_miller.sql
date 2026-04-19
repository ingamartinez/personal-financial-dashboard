ALTER TABLE "budgets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "budgets_user_period_live_idx" ON "budgets" USING btree ("user_id","period_start") WHERE "budgets"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "recurring_tx_user_day_live_idx" ON "recurring_transactions" USING btree ("user_id","day_of_month") WHERE "recurring_transactions"."deleted_at" IS NULL;