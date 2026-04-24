// Tables that are fully dumped and restored by the snapshot system (#471)
// and wiped by the reset action (#472). These are the "transactional" tables
// — every row is per-user and survives only as long as the user hasn't
// reset. Config tables (accounts, categories, rules, budgets, recurring
// definitions, counterparties, OAuth tokens, seeds) are NOT listed here:
// they outlive a reset and therefore outlive a restore too.
//
// IMPORTANT: the order of WIPE_ORDER matters — a table must be deleted
// BEFORE any other snapshot table that holds an FK into it, because the
// FKs between these tables are not deferrable. RESTORE_ORDER is the
// reverse: parents first, then dependents.
//
// Cross-FK map (only the ones INSIDE this set; FKs to config tables like
// accounts/categories/users are irrelevant because config survives):
//   reconciliation_decisions.tx_id       → transactions.id
//   reconciliation_decisions.merged_into → transactions.id
//   classification_corrections.tx_id     → transactions.id
//   email_receipts.matched_transaction_id→ transactions.id
//   rule_proposals.source_tx_id          → transactions.id

export const SNAPSHOT_TABLES = [
  // Children of `transactions` — must be deleted first, restored last.
  "reconciliation_decisions",
  "rule_proposals",
  "classification_corrections",
  "email_receipts",
  // Non-tx-dependent per-user tables.
  "account_snapshots",
  "skipped_consolidation_cycles",
  "recurring_gaps",
  // The core.
  "transactions",
  // Independent logs / reports / observability (per-user).
  "statement_imports",
  "ingestion_logs",
  "insights_reports",
  "parser_events",
  "parser_canary_events",
  "user_health_snapshots",
] as const;

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

// Delete children before parents.
export const WIPE_ORDER: readonly SnapshotTable[] = SNAPSHOT_TABLES;

// Insert parents before children.
export const RESTORE_ORDER: readonly SnapshotTable[] = [...SNAPSHOT_TABLES].reverse();

// Columns on `gmail_connections` that track ingestion cursor state (what
// messages we've already pulled). Reset nulls these out so re-ingest picks
// up from scratch; snapshot captures them so restore can put the user back
// exactly where they were. OAuth tokens, scopes, and the connection row
// itself stay put — they're config.
export const GMAIL_CURSOR_COLUMNS = ["last_pull_at", "last_pull_history_id"] as const;

export type GmailCursorColumn = (typeof GMAIL_CURSOR_COLUMNS)[number];
