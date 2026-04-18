ALTER TABLE "insights_reports" DROP CONSTRAINT "insights_reports_year_month_unique";--> statement-breakpoint
DROP INDEX "rules_priority_idx";--> statement-breakpoint
DROP INDEX "counterparty_aliases_kind_value_unique";--> statement-breakpoint
DROP INDEX "transactions_category_idx";--> statement-breakpoint
DROP INDEX "transactions_counterparty_idx";--> statement-breakpoint
DROP INDEX "transactions_occurred_idx";--> statement-breakpoint
CREATE INDEX "accounts_user_active_idx" ON "accounts" USING btree ("user_id","active");--> statement-breakpoint
CREATE INDEX "budgets_user_period_idx" ON "budgets" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "rules_user_priority_id_idx" ON "classification_rules" USING btree ("user_id","priority","id");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_user_pattern_category_unique" ON "classification_rules" USING btree ("user_id","pattern","category_slug");--> statement-breakpoint
CREATE INDEX "counterparties_user_display_idx" ON "counterparties" USING btree ("user_id","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_aliases_user_kind_value_unique" ON "counterparty_aliases" USING btree ("user_id","kind","value");--> statement-breakpoint
CREATE INDEX "ingestion_logs_user_started_idx" ON "ingestion_logs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_reports_user_year_month_unique" ON "insights_reports" USING btree ("user_id","year_month");--> statement-breakpoint
CREATE INDEX "recurring_gaps_user_detected_idx" ON "recurring_gaps" USING btree ("user_id","detected_at");--> statement-breakpoint
CREATE INDEX "recurring_tx_user_day_idx" ON "recurring_transactions" USING btree ("user_id","day_of_month");--> statement-breakpoint
CREATE INDEX "telegram_sessions_user_idx" ON "telegram_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_user_occurred_idx" ON "transactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_user_category_idx" ON "transactions" USING btree ("user_id","category_slug");--> statement-breakpoint
CREATE INDEX "transactions_user_counterparty_idx" ON "transactions" USING btree ("user_id","counterparty_id");