ALTER TABLE "physical_cards" ADD COLUMN "name" varchar(100);--> statement-breakpoint

-- #362: promote the card display name to the plastic. Backfill from any
-- linked sub-account (prefer COP side for consistency). Subs continue to
-- carry their own `name` for now; reads for linked cards will shift to
-- `physical_cards.name` with a fallback to the sub's name.
UPDATE "physical_cards" pc
SET "name" = (
  SELECT a."name"
  FROM "accounts" a
  WHERE a."physical_card_id" = pc."id"
    AND a."user_id" = pc."user_id"
    AND a."deleted_at" IS NULL
  ORDER BY CASE WHEN a."currency" = 'COP' THEN 0 ELSE 1 END, a."id"
  LIMIT 1
)
WHERE pc."name" IS NULL;
