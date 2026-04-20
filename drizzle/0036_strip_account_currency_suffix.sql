-- Data-only: strip trailing ` (COP)` / ` (USD)` / any 3-letter currency code
-- from accounts.name. The suffix was a pre-helper hack to disambiguate
-- multi-currency cards (same physical_card_id, different currency). Now that
-- formatAccountLabel renders currency, the suffix is redundant.
--
-- Original suffix is preserved in metadata.legacyNameSuffix for audit. Idempotent:
-- the regex predicate only matches rows that still carry a suffix, so re-runs
-- are no-ops.
UPDATE "accounts"
SET
  "metadata" = jsonb_set(
    coalesce("metadata", '{}'::jsonb),
    '{legacyNameSuffix}',
    to_jsonb(substring("name" from ' \([A-Z]{3}\)$'))
  ),
  "name" = regexp_replace("name", ' \([A-Z]{3}\)$', '')
WHERE "name" ~ ' \([A-Z]{3}\)$';
