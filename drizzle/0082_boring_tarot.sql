CREATE TYPE "public"."rule_proposal_source" AS ENUM('corrections', 'synthesized');--> statement-breakpoint
ALTER TABLE "rule_proposals" ADD COLUMN "pattern" text;--> statement-breakpoint
UPDATE "rule_proposals" SET "pattern" = '%' || "merchant" || '%' WHERE "pattern" IS NULL;--> statement-breakpoint
ALTER TABLE "rule_proposals" ALTER COLUMN "pattern" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_proposals" ADD COLUMN "source" "rule_proposal_source" DEFAULT 'corrections' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rule_proposals_user_pattern_category_pending_unique" ON "rule_proposals" USING btree ("user_id","pattern","category_slug") WHERE "rule_proposals"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "rule_proposals" ADD CONSTRAINT "rule_proposals_pattern_min_literals" CHECK (char_length(replace(replace("rule_proposals"."pattern", '%', ''), '_', '')) >= 2);
