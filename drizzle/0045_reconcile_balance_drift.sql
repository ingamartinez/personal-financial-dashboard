-- #368: reconcile `accounts.balance_cents` with the transaction ledger.
--
-- Motivation: until this migration, `accounts.balance_cents` was written
-- only by the explicit balance-adjustment flow — SMS, Telegram, manual,
-- recurring, CSV reconciliation and import never touched it. Every other
-- transaction-inserting path left the stored balance stale, producing
-- drift visible on the dashboard (e.g. Credit cards "Deuda total" not
-- moving after an SMS-ingested purchase).
--
-- The follow-up PR switches all read paths to derive balance from
-- `SUM(transactions.amount_cents)`. Before that flip, we collapse the
-- drift INTO the ledger so history is not lost: for every account where
-- `balance_cents - SUM(amount_cents) != 0`, we insert one adjustment
-- transaction carrying that delta. After this migration completes,
-- `SUM(transactions.amount_cents) == accounts.balance_cents` for every
-- account, and the upcoming derive-on-read flip is drift-free.
--
-- Idempotent-ish: safe to re-run on DBs with zero drift (no rows match
-- the HAVING). Re-running after new drift appears would create a second
-- reconciling tx — not dangerous, but not expected either. This migration
-- should run once, after which reads derive and writes go through the
-- ledger.

-- 1) Ensure a per-user 'adjustments' category exists for every user that
--    owns at least one drifting account. Mirrors the self-heal in
--    src/app/(app)/settings/accounts/actions.ts so tx insert does not
--    trip the (user_id, category_slug) FK.
INSERT INTO "categories" ("user_id", "slug", "name", "icon", "color", "sort_order")
SELECT DISTINCT drift."user_id", 'adjustments', 'Ajustes de saldo', 'wrench', '#475569', 1000
FROM (
  SELECT a."user_id", a."id"
  FROM "accounts" a
  LEFT JOIN "transactions" t ON t."account_id" = a."id"
  WHERE a."deleted_at" IS NULL
  GROUP BY a."user_id", a."id", a."balance_cents"
  HAVING a."balance_cents" - COALESCE(SUM(t."amount_cents"), 0) != 0
) AS drift
ON CONFLICT ("user_id", "slug") DO NOTHING;
--> statement-breakpoint

-- 2) Revive the 'adjustments' category for users that archived it.
UPDATE "categories"
SET "deleted_at" = NULL, "updated_at" = NOW()
WHERE "slug" = 'adjustments'
  AND "deleted_at" IS NOT NULL
  AND "user_id" IN (
    SELECT DISTINCT a."user_id"
    FROM "accounts" a
    LEFT JOIN "transactions" t ON t."account_id" = a."id"
    WHERE a."deleted_at" IS NULL
    GROUP BY a."user_id", a."id", a."balance_cents"
    HAVING a."balance_cents" - COALESCE(SUM(t."amount_cents"), 0) != 0
  );
--> statement-breakpoint

-- 3) Insert one reconciling transaction per drifting account. The
--    amount is the exact drift (`balance_cents - SUM(amount_cents)`)
--    so post-insert `SUM == balance_cents`.
INSERT INTO "transactions" (
  "user_id",
  "account_id",
  "occurred_at",
  "amount_cents",
  "currency",
  "description_raw",
  "category_slug",
  "classification_method",
  "source",
  "channel",
  "is_adjustment",
  "raw_data"
)
SELECT
  a."user_id",
  a."id",
  NOW(),
  a."balance_cents" - COALESCE(SUM(t."amount_cents"), 0),
  a."currency",
  'Ajuste de saldo (reconciliación pre-derived-balance, #368)',
  'adjustments',
  'manual',
  'balance_adjustment',
  'manual',
  true,
  jsonb_build_object(
    'migration', '0045_reconcile_balance_drift',
    'issue', 368,
    'driftCents', (a."balance_cents" - COALESCE(SUM(t."amount_cents"), 0))::text,
    'storedBalanceCents', a."balance_cents"::text,
    'ledgerSumCents', COALESCE(SUM(t."amount_cents"), 0)::text
  )
FROM "accounts" a
LEFT JOIN "transactions" t ON t."account_id" = a."id"
WHERE a."deleted_at" IS NULL
GROUP BY a."user_id", a."id", a."balance_cents", a."currency"
HAVING a."balance_cents" - COALESCE(SUM(t."amount_cents"), 0) != 0;
