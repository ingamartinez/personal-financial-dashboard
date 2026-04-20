CREATE TABLE "physical_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"institution" varchar(50) NOT NULL,
	"institution_slug" "institution_slug" DEFAULT 'other' NOT NULL,
	"network" varchar(20),
	"last4" varchar(4),
	"credit_limit_cents" bigint DEFAULT 0 NOT NULL,
	"statement_cutoff_day" smallint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "physical_cards" ADD CONSTRAINT "physical_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "physical_cards_user_idx" ON "physical_cards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "physical_cards_user_institution_idx" ON "physical_cards" USING btree ("user_id","institution_slug");
-- NOTE: the FK on accounts.physical_card_id → physical_cards.id is deliberately
-- added in migration 0041 AFTER the coalesce step, because existing accounts
-- rows carry physical_card_id UUIDs that don't yet have corresponding rows in
-- physical_cards. Ordering: create table → seed rows → add FK.
