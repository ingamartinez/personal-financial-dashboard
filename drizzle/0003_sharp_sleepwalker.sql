CREATE TYPE "public"."counterparty_type" AS ENUM('person', 'merchant', 'unknown');--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(60) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"type" "counterparty_type" DEFAULT 'unknown' NOT NULL,
	"default_category_slug" varchar(60),
	"notes" text,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "counterparty_id" integer;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_default_category_slug_categories_slug_fk" FOREIGN KEY ("default_category_slug") REFERENCES "public"."categories"("slug") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "counterparties_key_idx" ON "counterparties" USING btree ("key");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_counterparty_idx" ON "transactions" USING btree ("counterparty_id");