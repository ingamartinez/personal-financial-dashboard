ALTER TABLE "ingestion_logs" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingestion_logs" ADD COLUMN "resolved_txn_id" integer;--> statement-breakpoint
ALTER TABLE "ingestion_logs" ADD COLUMN "resolution" varchar(20);--> statement-breakpoint
ALTER TABLE "ingestion_logs" ADD CONSTRAINT "ingestion_logs_resolved_txn_id_transactions_id_fk" FOREIGN KEY ("resolved_txn_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingestion_logs_user_unresolved_idx" ON "ingestion_logs" USING btree ("user_id","started_at") WHERE "ingestion_logs"."status" = 'error' AND "ingestion_logs"."resolved_at" IS NULL;