ALTER TABLE "physical_cards" ADD COLUMN "next_payment_date" date;--> statement-breakpoint

-- #356: promote nextPaymentDate to physical_cards as the source of truth for
-- multi-currency cards. Backfill from the COP-side sub-account's metadata
-- (the primary currency); if there is no COP sub, fall back to any sub that
-- has the field. Leaves metadata.nextPaymentDate untouched — single-currency
-- cards (not linked to physical_cards) keep using metadata as before.
UPDATE "physical_cards" pc
SET "next_payment_date" = COALESCE(
  (
    SELECT (a."metadata"->>'nextPaymentDate')::date
    FROM "accounts" a
    WHERE a."physical_card_id" = pc."id"
      AND a."user_id" = pc."user_id"
      AND a."currency" = 'COP'
      AND a."metadata" ? 'nextPaymentDate'
      AND a."deleted_at" IS NULL
    LIMIT 1
  ),
  (
    SELECT (a."metadata"->>'nextPaymentDate')::date
    FROM "accounts" a
    WHERE a."physical_card_id" = pc."id"
      AND a."user_id" = pc."user_id"
      AND a."metadata" ? 'nextPaymentDate'
      AND a."deleted_at" IS NULL
    LIMIT 1
  )
)
WHERE pc."next_payment_date" IS NULL;
