-- Data-only (#346): coalesce `metadata.creditLimitCents` + `metadata.cutoffDay`
-- from paired sub-accounts (rows sharing the same `physical_card_id`) into one
-- new `physical_cards` row per UUID. Then strip those keys from the LIVE
-- sub-account metadata so there's a single source of truth for the shared cupo.
--
-- Scope
--   - INSERT: every distinct `physical_card_id` across ALL accounts (even
--     soft-deleted), so the FK added at the end has no dangling pointers.
--   - UPDATE: strips metadata keys ONLY from live rows. Soft-deleted accounts
--     keep their historical metadata as-is.
--   - Single-currency credit cards (physical_card_id IS NULL) are intentionally
--     untouched and keep using `metadata.creditLimitCents` — that migration is
--     explicitly out of scope for #346.
--
-- Winner selection when the pair has different values: MAX(creditLimitCents)
-- and MAX(cutoffDay). In practice pairs have matching values today; if they
-- don't, MAX is the conservative pick (larger cupo) and the user can edit via
-- the new UI.
--
-- Idempotent: the INSERT uses ON CONFLICT DO NOTHING and the UPDATE's
-- `jsonb - 'key'` operator is a no-op when the key is absent.
INSERT INTO "physical_cards" (
  "id",
  "user_id",
  "institution",
  "institution_slug",
  "network",
  "last4",
  "credit_limit_cents",
  "statement_cutoff_day",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  a."physical_card_id" AS "id",
  MIN(a."user_id") AS "user_id",
  MIN(a."institution") AS "institution",
  MIN(a."institution_slug")::"institution_slug" AS "institution_slug",
  MIN(a."metadata"->>'network') AS "network",
  MIN(a."metadata"->'last4s'->>0) AS "last4",
  COALESCE(MAX((a."metadata"->>'creditLimitCents')::bigint), 0) AS "credit_limit_cents",
  MAX(NULLIF(a."metadata"->>'cutoffDay', '')::smallint) AS "statement_cutoff_day",
  jsonb_build_object('coalescedFrom', jsonb_agg(a."id" ORDER BY a."id")) AS "metadata",
  NOW() AS "created_at",
  NOW() AS "updated_at"
FROM "accounts" a
WHERE a."physical_card_id" IS NOT NULL
GROUP BY a."physical_card_id"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "accounts"
SET "metadata" = "metadata" - 'creditLimitCents' - 'cutoffDay' - 'availableCreditCents'
WHERE "physical_card_id" IS NOT NULL
  AND "deleted_at" IS NULL;
--> statement-breakpoint
-- Now that every non-null physical_card_id has a corresponding row in
-- physical_cards (from the INSERT above), it's safe to add the FK.
-- Guarded by IF NOT EXISTS so re-applies don't fail.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_physical_card_id_physical_cards_id_fk'
  ) THEN
    ALTER TABLE "accounts"
      ADD CONSTRAINT "accounts_physical_card_id_physical_cards_id_fk"
      FOREIGN KEY ("physical_card_id") REFERENCES "public"."physical_cards"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
