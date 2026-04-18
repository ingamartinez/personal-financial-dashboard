CREATE TABLE "classification_rule_seeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"category_slug" varchar(60) NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"created_by_user_id" integer,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_uses_count_check" CHECK ("invite_codes"."uses_count" <= "invite_codes"."max_uses")
);
--> statement-breakpoint
ALTER TABLE "classification_rule_seeds" ADD CONSTRAINT "classification_rule_seeds_category_slug_categories_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."categories"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;