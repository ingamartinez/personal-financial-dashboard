-- #750: Backfill two data inconsistencies introduced by bugs fixed in this PR.
--
-- Part 1 — cycle off-by-one: dispatch.ts was labelling statement_imports.cycle
-- with the period START month instead of the period END month (the cutoff month).
-- All credit_card rows are shifted forward by exactly 1 month.
--
-- Because (user_id, account_id, cycle) has a partial unique index, a naive
-- single UPDATE shifting all rows simultaneously would collide (e.g. shifting
-- 2026-02 → 2026-03 when 2026-03 already exists). The fix temporarily drops
-- the unique index, runs the bulk update, then re-creates it. This is safe
-- inside a transaction: if the re-creation fails (unexpected duplicates exist),
-- the whole migration rolls back and data is untouched.
--
-- Part 2 — institution_slug mismatch: Amex and MC8268 accounts were seeded with
-- institution='Bancolombia' (human-readable) but institution_slug='other' (enum
-- default). Fix aligns slug with the human field. Idempotent: rows already set
-- to 'bancolombia' are not matched by the WHERE clause.

-- 1a. Drop the partial unique index so we can shift all rows in one pass.
DROP INDEX IF EXISTS statement_imports_cycle_unique;
--> statement-breakpoint

-- 1b. Shift cycle +1 month for all credit_card statement_imports.
UPDATE statement_imports si
SET cycle = to_char(
  to_date(si.cycle || '-01', 'YYYY-MM-DD') + interval '1 month',
  'YYYY-MM'
)
WHERE si.cycle IS NOT NULL
  AND si.cycle <> ''
  AND EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = si.account_id AND a.type = 'credit_card'
  );
--> statement-breakpoint

-- 1c. Re-create the partial unique index.
-- If the data has unexpected duplicates post-shift, this will fail loudly
-- and roll back the migration.
CREATE UNIQUE INDEX statement_imports_cycle_unique
  ON statement_imports (user_id, account_id, cycle)
  WHERE kind = 'extracto_detallado' AND cycle IS NOT NULL;
--> statement-breakpoint

-- 2. Fix institution_slug for accounts where the human-readable institution
--    field says 'Bancolombia' but the slug was left as 'other'.
UPDATE accounts
SET institution_slug = 'bancolombia'
WHERE institution_slug = 'other'
  AND institution ILIKE 'bancolombia';
