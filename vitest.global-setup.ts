/**
 * Vitest globalSetup — runs ONCE before/after the entire test suite.
 *
 * setup: clone one database per vitest worker from the base findash_test*
 * database, so workers never share a database and the suite can run with
 * fileParallelism on (#912). See `vitest.test-db-name.ts` for how a worker
 * resolves its own name.
 *
 * teardown: drop those clones, then run the defense-in-depth cleanup below
 * against the base database for single-threaded runs.
 *
 * The cleanup pass below is scoped to findash_test after all test files
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
import { resolveBaseTestDbName, workerDbName } from "./vitest.test-db-name";
import { resolveMaxWorkers } from "./vitest.workers";

const DEFAULT_SOCKET = process.platform === "darwin" ? "/tmp" : "/var/run/postgresql";

function connect(database: string) {
  return postgres({
    host: process.env.PGHOST ?? DEFAULT_SOCKET,
    database,
    username: process.env.PGUSER ?? process.env.USER,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    password: process.env.PGPASSWORD,
    max: 1,
    prepare: false,
  });
}

/** The pool ids vitest will hand out this run — 1-based, one per worker slot. */
function poolIds(): number[] {
  return Array.from({ length: resolveMaxWorkers() }, (_, i) => i + 1);
}

/**
 * setup: give every vitest worker its own database (#912).
 *
 * Each one is a `CREATE DATABASE … TEMPLATE <base>` clone, so the schema and
 * seed data come from the database `db:migrate:test` / `db:seed:test` already
 * prepared. A template copy is a file-level clone — far cheaper than running
 * migrations and the seed N times.
 *
 * This is what allows `fileParallelism` to be on. Sharing one database across
 * workers races on FK constraints and row counts: measured in #912 as a
 * non-deterministic 4-to-9 file failure across otherwise identical runs.
 */
export async function setup() {
  const baseName = resolveBaseTestDbName();
  const admin = connect("postgres");

  try {
    for (const poolId of poolIds()) {
      const name = workerDbName(baseName, poolId);
      // Unsafe-interpolated because CREATE/DROP DATABASE take no parameters.
      // Both names are already constrained to the `findash_test` prefix.
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${baseName}"`);
      // TEMPLATE clones the schema and rows but NOT per-database settings —
      // those live in pg_db_role_setting, outside the template. A clone would
      // otherwise inherit the server timezone, and the consolidate specs assert
      // on date boundaries: without this, `occurred_at` lands on 2025-11-15
      // 19:00 instead of 2025-11-16 and exactly two of them fail. Same reason
      // AGENTS.md marks the ALTER mandatory after a manual createdb.
      await admin.unsafe(`ALTER DATABASE "${name}" SET timezone TO 'UTC'`);
    }
  } catch (err) {
    throw new Error(
      `[vitest] Could not clone per-worker databases from "${baseName}". ` +
        `Postgres refuses TEMPLATE copies while anything else is connected to the ` +
        `template — close open psql sessions against it and retry. ` +
        `If "${baseName}" does not exist yet, run: bun run db:migrate:test && bun run db:seed:test. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    await admin.end();
  }
}

export async function teardown() {
  const baseName = resolveBaseTestDbName();

  // Drop the per-worker clones first. This supersedes the scoped DELETEs below
  // for anything a parallel run wrote — the whole database goes away, residue
  // included — but the DELETEs stay for single-threaded runs, which write to
  // the base database directly.
  const admin = connect("postgres");
  try {
    for (const poolId of poolIds()) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${workerDbName(baseName, poolId)}"`);
    }
  } finally {
    await admin.end();
  }

  // Safety: always target the resolved findash_test* database, never the dev DB.
  const db = connect(baseName);

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
