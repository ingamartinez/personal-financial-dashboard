/**
 * Shared test-database name resolution for `vitest.setup.ts` and
 * `vitest.global-setup.ts`.
 *
 * Safety property (must hold no matter what): integration tests can only
 * ever target a `findash_test*` database, never the dev DB. Within that
 * constraint, `FINDASH_TEST_DB` lets parallel lanes (worktrees) each use
 * their own database — e.g. `findash_test_818` — so their DELETE-heavy
 * cleanup doesn't corrupt another lane's run.
 */

const DEFAULT_TEST_DB_NAME = "findash_test";
const ALLOWED_PREFIX_RE = /^findash_test/;

/**
 * Resolves the test database name from `FINDASH_TEST_DB`, falling back to
 * `findash_test` when unset. Throws if the override doesn't match
 * `/^findash_test/` — that's the only thing standing between tests and the
 * dev DB.
 */
export function resolveTestDbName(): string {
  const override = process.env.FINDASH_TEST_DB;

  if (!override) {
    return DEFAULT_TEST_DB_NAME;
  }

  if (!ALLOWED_PREFIX_RE.test(override)) {
    throw new Error(
      `[vitest] FINDASH_TEST_DB="${override}" does not start with "findash_test". ` +
        `Refusing to run tests against a non-test database.`,
    );
  }

  return override;
}
