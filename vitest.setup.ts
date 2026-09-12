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

import { afterAll } from "vitest";

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

/**
 * #954 — drain pending macrotasks before the environment is torn down.
 *
 * Radix's FocusScope schedules a `setTimeout(..., 0)` in its unmount effect
 * (`@radix-ui/react-focus-scope`, the AUTOFOCUS_ON_UNMOUNT dispatch). Testing
 * Library's `cleanup()` unmounts the tree, so that timer is *queued by the
 * unmount itself* — the tests are not leaving a component mounted.
 *
 * That timer is a Node timer, not a jsdom one: vitest's jsdom environment
 * copies the window's globals onto `globalThis` but deliberately skips
 * `setTimeout`, so `dom.window.close()` at teardown does not cancel it.
 * `CustomEvent`, by contrast, IS one of the copied globals and gets restored
 * to Node's implementation on teardown. A callback that survives into that
 * window therefore builds a Node `CustomEvent` and dispatches it on a jsdom
 * element, which throws:
 *
 *   TypeError: Failed to execute 'dispatchEvent' on 'EventTarget':
 *              parameter 1 is not of type 'Event'.
 *
 * Nothing caught it by then, so it surfaces as an unhandled error and vitest
 * exits 1 with every test green — an at-random blocked merge for the
 * `scripts/ship.sh --merge` gate.
 *
 * Seven test files end with such a timer still queued; whether it fires before
 * teardown is a race the machine's load decides. One macrotask turn settles it:
 * timers with the same delay fire in scheduling order, so anything queued
 * before this hook has run by the time it resolves — inside the live realm,
 * which is exactly where those callbacks expect to be.
 *
 * Fake timers are NOT the fix here: they would relocate the race to whichever
 * test forgot to restore them.
 */
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
