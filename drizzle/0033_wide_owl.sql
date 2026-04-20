CREATE TYPE "public"."rule_proposal_status" AS ENUM('pending', 'approved', 'denied');--> statement-breakpoint
CREATE TABLE "rule_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"merchant" varchar(200) NOT NULL,
	"category_slug" varchar(60) NOT NULL,
	"correction_txn_ids" jsonb NOT NULL,
	"status" "rule_proposal_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rule_proposals" ADD CONSTRAINT "rule_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_proposals" ADD CONSTRAINT "rule_proposals_user_category_fk" FOREIGN KEY ("user_id","category_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rule_proposals_user_merchant_category_pending_unique" ON "rule_proposals" USING btree ("user_id","merchant","category_slug") WHERE "rule_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "rule_proposals_user_status_idx" ON "rule_proposals" USING btree ("user_id","status","created_at");