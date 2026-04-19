-- Per-user categories migration.
--
-- This migration moves `categories` from a global shared taxonomy to a
-- per-user taxonomy. Each existing user gets a clone of the current global
-- rows; the global template survives in a new `category_seeds` table used
-- by the signup flow to materialize categories for future users.
--
-- Order of operations is load-bearing — do NOT reorder blocks without
-- re-deriving the safety argument. See PR notes for the full rationale.

-- Step 1: Create the new global template table (category_seeds).
CREATE TABLE "category_seeds" (
	"slug" varchar(60) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"parent_slug" varchar(60),
	"icon" varchar(40),
	"color" varchar(20),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint

-- Step 2: Seed category_seeds from the current global categories rows BEFORE
-- adding the self-FK (so we don't need to worry about insert ordering).
INSERT INTO "category_seeds" ("slug", "name", "parent_slug", "icon", "color", "sort_order")
SELECT "slug", "name", "parent_slug", "icon", "color", "sort_order"
FROM "categories";
--> statement-breakpoint

-- Step 3: Add the self-FK on category_seeds.parent_slug now that data is in.
ALTER TABLE "category_seeds" ADD CONSTRAINT "category_seeds_parent_slug_category_seeds_slug_fk" FOREIGN KEY ("parent_slug") REFERENCES "public"."category_seeds"("slug") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Step 4: Drop every FK that points at `categories.slug`. We're about to
-- reshape categories into a per-user table with composite (user_id, slug)
-- uniqueness, so the existing simple FKs cannot survive.
ALTER TABLE "budgets" DROP CONSTRAINT "budgets_category_slug_categories_slug_fk";
--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT "categories_parent_slug_categories_slug_fk";
--> statement-breakpoint
ALTER TABLE "classification_rule_seeds" DROP CONSTRAINT "classification_rule_seeds_category_slug_categories_slug_fk";
--> statement-breakpoint
ALTER TABLE "classification_rules" DROP CONSTRAINT "classification_rules_category_slug_categories_slug_fk";
--> statement-breakpoint
ALTER TABLE "counterparties" DROP CONSTRAINT "counterparties_default_category_slug_categories_slug_fk";
--> statement-breakpoint
ALTER TABLE "recurring_transactions" DROP CONSTRAINT "recurring_transactions_category_slug_categories_slug_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_category_slug_categories_slug_fk";
--> statement-breakpoint

-- Step 5: Drop the old global UNIQUE on slug so we can add per-user rows with
-- duplicated slugs.
ALTER TABLE "categories" DROP CONSTRAINT "categories_slug_unique";
--> statement-breakpoint

-- Step 6: Add the new per-user columns (user_id NULLABLE for now — we
-- populate it via backfill, then switch to NOT NULL in step 9).
ALTER TABLE "categories" ADD COLUMN "user_id" integer;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint

-- Step 7: Backfill — every existing user gets a clone of every global
-- category row. Original globals still exist (user_id IS NULL) and are
-- deleted in step 8.
INSERT INTO "categories" ("user_id", "slug", "name", "parent_slug", "icon", "color", "sort_order", "created_at", "updated_at")
SELECT u.id, c.slug, c.name, c.parent_slug, c.icon, c.color, c.sort_order, c.created_at, c.created_at
FROM "users" u, "categories" c
WHERE c.user_id IS NULL;
--> statement-breakpoint

-- Step 8: Drop the old global rows now that every user has their own clones.
DELETE FROM "categories" WHERE "user_id" IS NULL;
--> statement-breakpoint

-- Step 9: With all surviving rows now attributed to a user, we can enforce
-- user_id NOT NULL.
ALTER TABLE "categories" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint

-- Step 10: Wire up the user FK + unique index + partial index for
-- soft-delete filtering.
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "categories_user_slug_unique" ON "categories" USING btree ("user_id","slug");
--> statement-breakpoint
CREATE INDEX "categories_user_live_idx" ON "categories" USING btree ("user_id") WHERE "categories"."deleted_at" IS NULL;
--> statement-breakpoint

-- Step 11: Composite self-FK — parent_slug must live in the same user's
-- categories. Uses the (user_id, slug) unique index from step 10.
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_parent_fk" FOREIGN KEY ("user_id","parent_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Step 12: Repoint classification_rule_seeds.category_slug FK from the old
-- global `categories` table to `category_seeds`. Rule seeds are global; they
-- template out per-user via copyRuleSeedsToUser on signup.
ALTER TABLE "classification_rule_seeds" ADD CONSTRAINT "classification_rule_seeds_category_slug_category_seeds_slug_fk" FOREIGN KEY ("category_slug") REFERENCES "public"."category_seeds"("slug") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Step 13: Composite FKs on every table that used to point at categories.slug.
-- Each uses (user_id, category_slug) → categories(user_id, slug); since the
-- per-user backfill in step 7 gives every user every slug, existing rows
-- continue to resolve after the swap.
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_category_fk" FOREIGN KEY ("user_id","category_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "classification_rules" ADD CONSTRAINT "classification_rules_user_category_fk" FOREIGN KEY ("user_id","category_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_user_category_fk" FOREIGN KEY ("user_id","default_category_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_user_category_fk" FOREIGN KEY ("user_id","category_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_category_fk" FOREIGN KEY ("user_id","category_slug") REFERENCES "public"."categories"("user_id","slug") ON DELETE set null ON UPDATE no action;
