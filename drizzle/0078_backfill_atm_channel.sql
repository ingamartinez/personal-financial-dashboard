-- #766: Backfill existing ATM withdrawal transactions to channel='cash_withdrawal'.
--
-- ATM withdrawals were ingested with the default channel='bank' before this fix.
-- They can be identified by description_raw matching 'Retiro ATM %' — all rows
-- with that prefix were produced by the sms-pipeline atm_withdrawal case and
-- no other kind produces that prefix.
--
-- Idempotent: rows already set to 'cash_withdrawal' are not matched.

UPDATE transactions
SET channel = 'cash_withdrawal'
WHERE description_raw LIKE 'Retiro ATM %'
  AND channel = 'bank';
