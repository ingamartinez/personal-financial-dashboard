/**
 * Vitest globalSetup — runs ONCE before/after the entire test suite.
 *
 * teardown: defense-in-depth cleanup for findash_test after all test files
 * complete. Each individual test file is responsible for its own afterEach /
 * afterAll teardown (Layer 1). This global pass (Layer 2) catches any residue
 * that slips through when a test file forgets to clean up or a per-file
 * teardown silently fails.
 *
 * Rules:
 *  - NEVER truncates full tables — always scoped to known test markers.
 *  - NEVER deletes seeded data (user_id=1 bootstrap accounts/categories/rules).
 *  - Only targets a findash_test* database — the same one resolved by
 *    `vitest.setup.ts` via `resolveTestDbName()` (see `vitest.test-db-name.ts`).
 *    It is never overridable outside the `findash_test*` prefix, but it is NOT
 *    hardcoded to the literal `findash_test` — it must track FINDASH_TEST_DB
 *    or it cleans the wrong lane's database.
 *  - Order matters: delete child rows before parent rows (FK constraints).
 *
 * Add new patterns here when a new test file introduces persistent residue.
 */

import postgres from "postgres";
import { resolveTestDbName } from "./vitest.test-db-name";

export async function teardown() {
  // Safety: always target the resolved findash_test* database, never the dev DB.
  const defaultSocket = process.platform === "darwin" ? "/tmp" : "/var/run/postgresql";
  const db = postgres({
    host: process.env.PGHOST ?? defaultSocket,
    database: resolveTestDbName(),
    username: process.env.PGUSER ?? process.env.USER,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    password: process.env.PGPASSWORD,
    max: 1,
    prepare: false,
  });

  try {
    // ── Step 1: delete rows that depend on test user accounts (FK children) ──

    // Transactions owned by test users (identified by email pattern). Also
    // covers the cross-tenant transactions left by classification-reason tests.
    await db`
      DELETE FROM transactions
      WHERE user_id IN (
        SELECT id FROM users
        WHERE email LIKE '%@test.local'
          AND id <> 1
      )
    `;

    // Transactions for user_id=1 keyed by well-known external_id / description
    // prefixes seeded by test files.
    await db`
      DELETE FROM transactions
      WHERE external_id LIKE 'TEST-%'
         OR external_id LIKE 'test-%'
         OR external_id LIKE 'bcol-sms:%'
         OR description_raw LIKE '__slos_test_tx__%'
    `;

    // ── Step 2: other FK children of users/accounts ──────────────────────────

    // parser_events: inserted by sms/route tests and slo-alerts tests for
    // user_id=1. Per-file teardowns should cover this; this is the safety net.
    await db`DELETE FROM parser_events WHERE user_id = 1`;

    // ingestion_logs: side effects of createManualEntry and SMS ingest tests.
    await db`
      DELETE FROM ingestion_logs
      WHERE user_id = 1
        AND source IN ('sms', 'manual')
    `;

    // Recurring transactions owned by test users.
    await db`
      DELETE FROM recurring_transactions
      WHERE user_id IN (
        SELECT id FROM users
        WHERE email LIKE '%@test.local'
          AND id <> 1
      )
    `;

    // ── Step 3: accounts + categories + users ────────────────────────────────
    // Several tenant-isolation tests create ad-hoc users (ON CONFLICT upsert)
    // without cleaning up the user row. These are identifiable by email domain.
    // Bootstrap user (id=1, email=ing.amartinez94@gmail.com) is not matched.
    await db`
      DELETE FROM accounts
      WHERE user_id IN (
        SELECT id FROM users
        WHERE email LIKE '%@test.local'
          AND id <> 1
      )
    `;
    await db`
      DELETE FROM categories
      WHERE user_id IN (
        SELECT id FROM users
        WHERE email LIKE '%@test.local'
          AND id <> 1
      )
    `;
    await db`
      DELETE FROM users
      WHERE email LIKE '%@test.local'
        AND id <> 1
    `;
  } finally {
    await db.end();
  }
}
