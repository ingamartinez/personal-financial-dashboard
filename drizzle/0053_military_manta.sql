CREATE TABLE "skipped_consolidation_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"cycle" varchar(7) NOT NULL,
	"reason" text,
	"skipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "skipped_consolidation_cycles" ADD CONSTRAINT "skipped_consolidation_cycles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skipped_consolidation_cycles" ADD CONSTRAINT "skipped_consolidation_cycles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skipped_consolidation_cycles_live_unique" ON "skipped_consolidation_cycles" USING btree ("user_id","account_id","cycle") WHERE "skipped_consolidation_cycles"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "skipped_consolidation_cycles_user_account_idx" ON "skipped_consolidation_cycles" USING btree ("user_id","account_id") WHERE "skipped_consolidation_cycles"."deleted_at" IS NULL;