ALTER TABLE "accounts" ADD COLUMN "physical_card_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "accounts_user_live_idx" ON "accounts" USING btree ("user_id") WHERE "accounts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "accounts_physical_card_live_idx" ON "accounts" USING btree ("physical_card_id") WHERE "accounts"."physical_card_id" IS NOT NULL AND "accounts"."deleted_at" IS NULL;