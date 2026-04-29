CREATE TYPE "public"."recurring_amount_type" AS ENUM('fixed', 'variable');--> statement-breakpoint
CREATE TYPE "public"."recurring_proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "recurring_description_patterns" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"recurring_id" integer NOT NULL,
	"pattern" text NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"pattern_ambiguous" boolean DEFAULT false NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_link_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"recurring_id" integer NOT NULL,
	"tx_id" integer NOT NULL,
	"year_month" varchar(7) NOT NULL,
	"real_amount_cents" bigint NOT NULL,
	"real_currency" "currency" NOT NULL,
	"description_raw" text,
	"account_id" integer NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"recurring_id" integer NOT NULL,
	"proposal_type" varchar(40) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "recurring_proposal_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "amount_type" "recurring_amount_type" DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_description_patterns" ADD CONSTRAINT "recurring_description_patterns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_description_patterns" ADD CONSTRAINT "recurring_description_patterns_recurring_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_link_observations" ADD CONSTRAINT "recurring_link_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_link_observations" ADD CONSTRAINT "recurring_link_observations_recurring_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_link_observations" ADD CONSTRAINT "recurring_link_observations_tx_id_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_link_observations" ADD CONSTRAINT "recurring_link_observations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_proposals" ADD CONSTRAINT "recurring_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_proposals" ADD CONSTRAINT "recurring_proposals_recurring_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_description_patterns_unique" ON "recurring_description_patterns" USING btree ("user_id","recurring_id","pattern");--> statement-breakpoint
CREATE INDEX "recurring_description_patterns_user_pattern_idx" ON "recurring_description_patterns" USING btree ("user_id","pattern");--> statement-breakpoint
CREATE INDEX "recurring_description_patterns_recurring_idx" ON "recurring_description_patterns" USING btree ("recurring_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_link_observations_unique" ON "recurring_link_observations" USING btree ("user_id","recurring_id","tx_id","year_month");--> statement-breakpoint
CREATE INDEX "recurring_link_observations_pending_idx" ON "recurring_link_observations" USING btree ("user_id","recurring_id") WHERE "recurring_link_observations"."manual" = true AND "recurring_link_observations"."applied" = false;--> statement-breakpoint
CREATE INDEX "recurring_link_observations_recurring_idx" ON "recurring_link_observations" USING btree ("recurring_id");--> statement-breakpoint
CREATE INDEX "recurring_proposals_user_status_idx" ON "recurring_proposals" USING btree ("user_id","status") WHERE "recurring_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "recurring_proposals_recurring_idx" ON "recurring_proposals" USING btree ("recurring_id");