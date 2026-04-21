-- #370: drop the `accounts.balance_cents` column. It became dead weight
-- after #368 switched every reader to derive balance from
-- `SUM(transactions.amount_cents)`. Migration 0045 reconciled any drift
-- between the stored column and the ledger, so post-0045 the column
-- carried no information the ledger didn't already have. Safe to drop
-- after soak-time in prod (merged main 2026-04-20, dropping 2026-04-21).
ALTER TABLE "accounts" DROP COLUMN "balance_cents";