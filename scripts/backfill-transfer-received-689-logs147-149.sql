-- Backfill for issue #689: transfer_received_to_savings
-- Resolves prod ingestion_logs 147 and 149 (Bancolombia duplicate SMS for the
-- same $11,740,000 DIAN/Tesoro Nacional refund on 2026-04-30).
--
-- What happened:
--   - Bancolombia sent TWO SMS for a single payment event, 4 minutes apart
--   - SMS 147: "...el 18:04 a las 30/04/2026..." (first notification)
--   - SMS 149: "...el 18:08 a las 30/04/2026..." (second notification, duplicate)
--   - The old externalId algorithm hashed the full body, so different timestamps
--     produced different hashes → parser would have inserted two transactions
--   - The new parser (#689) hashes semantic fields only (no timestamp), so both
--     SMS produce externalId = bcol-sms:5b75ed23c73e5fb408f7f06e
--
-- This backfill:
--   1. Inserts the single correct tx (uses log 147 body as authoritative)
--      Category = "reembolso" (intentional: this IS a DIAN tax refund, not
--      generic income; the parser uses "otros-ingresos" because it cannot know)
--   2. Resolves log 147 → retried_success + resolved_txn_id
--   3. Resolves log 149 → duplicate (no resolved_txn_id, it's a duplicate)
--
-- Idempotent: safe to re-run; checks externalId before inserting.
--
-- DO NOT execute without confirming:
--   a) The migration for #689 has been deployed to prod
--   b) SELECT id FROM accounts WHERE user_id=1 AND type='savings' AND
--      currency='COP' AND institution_slug='bancolombia' AND deleted_at IS NULL;
--      — must return exactly 1 row

BEGIN;
DO $$
DECLARE
  ahorros_id integer;
  new_tx_id  integer;
  -- externalId computed by the new transfer_received_to_savings algorithm:
  -- hashId("bcol-sms", ["transfer-received-to-savings", "bcol-sms",
  --                     "1174000000", "COP", "2026-04-30", "DIR TESORO NACI"])
  -- = SHA256("transfer-received-to-savings|bcol-sms|1174000000|COP|2026-04-30|DIR TESORO NACI")
  --   sliced to 24 hex chars, prefixed with "bcol-sms:"
  ext_id text := 'bcol-sms:5b75ed23c73e5fb408f7f06e';
BEGIN
  -- Resolve Bancolombia COP savings account for user_id=1
  SELECT id INTO ahorros_id
  FROM accounts
  WHERE user_id = 1
    AND name = 'Bancolombia Ahorros'
    AND currency = 'COP'
    AND deleted_at IS NULL;

  IF ahorros_id IS NULL THEN
    RAISE EXCEPTION 'Bancolombia Ahorros COP not found for user_id=1. Check account name in prod.';
  END IF;

  -- Idempotency guard
  IF EXISTS (SELECT 1 FROM transactions WHERE external_id = ext_id) THEN
    RAISE NOTICE 'Backfill already applied (externalId % exists). Skipping tx insert.', ext_id;
  ELSE
    -- Insert the single authoritative tx
    -- amount_cents = 1174000000 = $11,740,000.00 × 100
    INSERT INTO transactions (
      user_id,
      account_id,
      occurred_at,
      amount_cents,
      currency,
      description_raw,
      merchant,
      channel,
      category_slug,
      classification_method,
      source,
      external_id,
      raw_data,
      created_at,
      updated_at
    ) VALUES (
      1,
      ahorros_id,
      '2026-04-30 18:04:00+00'::timestamptz,
      1174000000,
      'COP',
      'Bancolombia: Recibiste un pago por $11,740,000.00 de DIR TESORO NACI a tu cuenta AHORROS, el 18:04 a las 30/04/2026. Si tienes dudas, llamanos al 018000931987. Estamos cerca.',
      'DIR TESORO NACI',
      'bank',
      'reembolso',    -- specifically a DIAN tax refund; parser default is "otros-ingresos"
      'manual',
      'manual',       -- backfill; future re-ingestion would produce source="sms"
      ext_id,
      jsonb_build_object(
        'kind',              'transfer_received_to_savings',
        'originDescriptor',  'DIR TESORO NACI',
        'occurredTime',      '18:04',
        'backfill',          '689'
      ),
      now(),
      now()
    ) RETURNING id INTO new_tx_id;

    RAISE NOTICE 'Inserted tx id=% for DIAN refund $11,740,000 on 2026-04-30', new_tx_id;
  END IF;

  -- Resolve log 147 (the SMS we treat as authoritative — first delivery at 18:04)
  UPDATE ingestion_logs
  SET
    status         = 'resolved',
    resolved_at    = now(),
    resolution     = 'retried_success',
    resolved_txn_id = (
      SELECT id FROM transactions WHERE external_id = ext_id LIMIT 1
    )
  WHERE id = 147;

  IF NOT FOUND THEN
    RAISE WARNING 'ingestion_log 147 not found — skipping update';
  ELSE
    RAISE NOTICE 'Resolved log 147 → retried_success';
  END IF;

  -- Resolve log 149 (the Bancolombia duplicate — 4 minutes later at 18:08)
  UPDATE ingestion_logs
  SET
    status          = 'resolved',
    resolved_at     = now(),
    resolution      = 'duplicate',
    resolved_txn_id = NULL   -- duplicate, no new tx
  WHERE id = 149;

  IF NOT FOUND THEN
    RAISE WARNING 'ingestion_log 149 not found — skipping update';
  ELSE
    RAISE NOTICE 'Resolved log 149 → duplicate (no tx, same event as 147)';
  END IF;

END
$$;
COMMIT;
