-- Backfill: compra de cartera TC — tx 1751 (#688)
--
-- Context:
--   tx 1751 was ingested as a savings debit with channel='bank' and
--   category_slug='inversiones'. It should be the savings_disbursement leg of a
--   cartera TC pair:
--     - savings *6126 receives COP $29,000,000 (channel=transfer, category=null)
--     - AMEX *5367 (COP account) gets a deferred debit of -COP $29,000,000
--       with installmentsTotal=60 and installmentRateEmX10k=13900 (1.39% EM)
--
-- Idempotent: DO block aborts cleanly if already applied.
-- Safety guard: the UPDATE only proceeds when tx 1751 is still in the broken
-- state (channel='bank', category_slug='inversiones', transfer_group_id IS NULL).

BEGIN;

DO $$
DECLARE
  new_uuid uuid := gen_random_uuid();
  amex_id  integer;
  existing_tc_count integer;
BEGIN
  -- Resolve the AMEX *5367 COP account
  SELECT id INTO amex_id
  FROM accounts
  WHERE user_id = 1
    AND name = 'Amex *5367'
    AND currency = 'COP'
    AND deleted_at IS NULL;

  IF amex_id IS NULL THEN
    RAISE EXCEPTION 'Amex *5367 COP account not found for user_id=1';
  END IF;

  -- Idempotency: abort early if TC counterpart already exists
  SELECT count(*) INTO existing_tc_count
  FROM transactions
  WHERE external_id = 'cartera-tc-688-backfill-1751-tc';

  IF existing_tc_count > 0 THEN
    RAISE NOTICE 'Backfill already applied (TC counterpart exists). Skipping.';
    RETURN;
  END IF;

  -- Migrate tx 1751 to the savings_disbursement role.
  -- Guard: only proceed when the row is still in its original broken state.
  UPDATE transactions
  SET channel            = 'transfer',
      category_slug      = NULL,
      transfer_group_id  = new_uuid,
      raw_data           = COALESCE(raw_data, '{}'::jsonb) || jsonb_build_object(
                             'kind',     'cartera_tc',
                             'role',     'savings_disbursement',
                             'backfill', '688'
                           ),
      external_id        = 'cartera-tc-688-backfill-1751-savings',
      updated_at         = now()
  WHERE id               = 1751
    AND user_id          = 1
    AND channel          = 'bank'
    AND category_slug    = 'inversiones'
    AND transfer_group_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'tx 1751 not in expected state (channel=bank, category=inversiones, '
      'transfer_group_id IS NULL) — inspect row and re-run or apply manually';
  END IF;

  -- Insert the AMEX TC debit counterpart
  INSERT INTO transactions (
    user_id,
    account_id,
    occurred_at,
    amount_cents,
    currency,
    description_raw,
    channel,
    category_slug,
    source,
    external_id,
    transfer_group_id,
    installments_total,
    installment_rate_bps,
    raw_data,
    created_at,
    updated_at
  )
  VALUES (
    1,
    amex_id,
    '2026-04-23 05:00:00+00'::timestamptz,  -- approximate; SMS had no date
    -2900000000,                             -- -COP $29,000,000 in cents
    'COP',
    'Compra de Cartera TC (60×)',
    'transfer',
    NULL,
    'manual',
    'cartera-tc-688-backfill-1751-tc',
    new_uuid,
    60,
    13900,                                   -- 1.39% EM × 10000
    jsonb_build_object(
      'kind',            'cartera_tc',
      'role',            'tc_debit',
      'installmentsTotal',       60,
      'installmentRateEmX10k',   13900,
      'originalSmsBody', 'Bancolombia confirma compra de cartera por $29,000,000.00 en su TC AMEX *5367. La tasa es de 1.39% y el plazo de 60 meses.',
      'backfill',        '688'
    ),
    now(),
    now()
  );

  -- Resolve the orphaned ingestion log (log id=134).
  -- Point resolved_txn_id to tx 1751 (the savings row corrected from the SMS).
  -- The TC leg can be cross-referenced via its external_id 'cartera-tc-688-backfill-1751-tc'.
  UPDATE ingestion_logs
  SET status       = 'resolved',
      resolved_at  = now(),
      resolution   = 'retried_success',
      resolved_txn_id = 1751
  WHERE id = 134;

END
$$;

COMMIT;
