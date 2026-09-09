/**
 * Vitest global setup — runs BEFORE any test file is imported.
 *
 * Jobs:
 *   1. Force integration tests to target a `findash_test*` Postgres DB,
 *      NEVER the dev DB. Tests DELETE rows during cleanup, so running them
 *      against a DB with real data would silently destroy work. The name
 *      defaults to `findash_test` but can be pinned per lane (e.g. per
 *      worktree) via `FINDASH_TEST_DB` — see `resolveTestDbName()` in
 *      `vitest.test-db-name.ts`. The one guarantee that always holds: the
 *      resolved name always starts with `findash_test`, so this can never
 *      resolve to the dev DB.
 *   2. Hard-fail if anything tried to override this with a name outside
 *      that guarantee (e.g. someone exported FINDASH_TEST_DB=findash or
 *      PGDATABASE=findash in their shell).
 *   3. Set a deterministic TELEGRAM_TOKEN_ENCRYPTION_KEY so the crypto
 *      module (`src/lib/crypto/symmetric.ts`) loads successfully under test.
 *      The module throws at import time if the key is missing or malformed.
 *
 * See `src/lib/db/index.ts` — it reads `process.env.PGDATABASE` at import
 * time, so this file MUST run before any `import { db } from ...` happens.
 */

import { resolveTestDbName } from "./vitest.test-db-name";

const TEST_DB_NAME = resolveTestDbName();

process.env.PGDATABASE = TEST_DB_NAME;

// Safety check: abort loudly if anything stomped on it.
if (process.env.PGDATABASE !== TEST_DB_NAME) {
  throw new Error(
    `[vitest.setup] Expected PGDATABASE=${TEST_DB_NAME}, got ${process.env.PGDATABASE}. ` +
      `Refusing to run tests against a non-test database.`,
  );
}

// 32 zero bytes, base64-encoded. Deterministic so tampering tests are stable;
// trivially insecure — do NOT reuse anywhere outside the test runtime.
process.env.TELEGRAM_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// Anthropic SDK requires ANTHROPIC_API_KEY at client-init time, even when
// the caller injects a mock fetch. Vitest isolates env so .env.local is
// NOT loaded here — set a dummy key so AI tests that rely on env-default
// credential resolution don't blow up before reaching the mock.
if (!process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-dummy-for-vitest-do-not-use";
}
