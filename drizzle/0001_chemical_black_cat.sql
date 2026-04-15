ALTER TABLE "recurring_transactions" ADD COLUMN "skipped_months" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "notes" text;