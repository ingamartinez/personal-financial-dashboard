ALTER TABLE "recurring_gaps" ADD COLUMN "resolution" varchar(20);--> statement-breakpoint
ALTER TABLE "recurring_gaps" ADD COLUMN "resolution_tx_id" integer;--> statement-breakpoint
ALTER TABLE "recurring_gaps" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recurring_gaps" ADD CONSTRAINT "recurring_gaps_resolution_tx_id_transactions_id_fk" FOREIGN KEY ("resolution_tx_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_gaps_open_idx" ON "recurring_gaps" USING btree ("user_id","detected_at") WHERE "recurring_gaps"."resolution" IS NULL;