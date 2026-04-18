-- Custom data-only migration: dedup classification_rules.
-- Keeps the lowest id per (pattern, category_slug); deletes the rest.
-- Root cause: seed.ts called onConflictDoNothing without a target and there
-- is no UNIQUE constraint, so every re-run inserted all seed patterns again.
-- A permanent UNIQUE lands under #183 as (user_id, pattern, category_slug).
DELETE FROM "classification_rules"
WHERE "id" NOT IN (
  SELECT MIN("id")
  FROM "classification_rules"
  GROUP BY "pattern", "category_slug"
);
