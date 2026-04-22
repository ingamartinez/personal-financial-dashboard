-- #411: TC rate precision bump from 2→4 decimals.
--
-- Before: `installment_rate_bps smallint` stored EM in basis points (1 bps =
-- 0.01%), so values like Bancolombia's `1.9110%` lost the last two decimals
-- (stored as 191, printed back as 1.9100%).
--
-- After: `installment_rate_bps integer` stores EM as "percent × 10000" (so
-- 1.9110% → 19110). The column NAME stays for compatibility with the #406
-- snapshot; the unit meaning changes, documented in schema.ts.
--
-- Data migration: pre-existing rows are rescaled by × 100 on both the column
-- and the `creditRateBuckets` JSONB keys — lossless for values that were
-- already whole bps integers.

ALTER TABLE "transactions"
  ALTER COLUMN "installment_rate_bps" SET DATA TYPE integer
  USING "installment_rate_bps" * 100;
--> statement-breakpoint
UPDATE "accounts"
SET "metadata" = jsonb_set(
  jsonb_set(
    jsonb_set(
      "metadata",
      '{creditRateBuckets,oneMonth}',
      to_jsonb(COALESCE(("metadata"->'creditRateBuckets'->>'oneMonth')::int, 0) * 100)
    ),
    '{creditRateBuckets,months2to36}',
    to_jsonb(COALESCE(("metadata"->'creditRateBuckets'->>'months2to36')::int, 0) * 100)
  ),
  '{creditRateBuckets,advances}',
  to_jsonb(COALESCE(("metadata"->'creditRateBuckets'->>'advances')::int, 0) * 100)
)
WHERE "type" = 'credit_card'
  AND "metadata" ? 'creditRateBuckets';
