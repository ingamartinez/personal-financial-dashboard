/**
 * Vitest global setup — runs BEFORE any test file is imported.
 *
 * Two jobs:
 *   1. Force integration tests to target the `findash_test` Postgres DB,
 *      NEVER the dev DB. Tests DELETE rows during cleanup, so running them
 *      against a DB with real data would silently destroy work.
 *   2. Hard-fail if anything tried to override this with a non-test DB name
 *      (e.g. someone exported PGDATABASE=findash in their shell).
 *
 * See `src/lib/db/index.ts` — it reads `process.env.PGDATABASE` at import
 * time, so this file MUST run before any `import { db } from ...` happens.
 */

const TEST_DB_NAME = "findash_test";

process.env.PGDATABASE = TEST_DB_NAME;

// Safety check: abort loudly if anything stomped on it.
if (process.env.PGDATABASE !== TEST_DB_NAME) {
  throw new Error(
    `[vitest.setup] Expected PGDATABASE=${TEST_DB_NAME}, got ${process.env.PGDATABASE}. ` +
      `Refusing to run tests against a non-test database.`,
  );
}
