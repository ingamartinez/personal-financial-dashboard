/**
 * Shared test-database name resolution for `vitest.setup.ts` and
 * `vitest.global-setup.ts`.
 *
 * Safety property (must hold no matter what): integration tests can only
 * ever target a `findash_test*` database, never the dev DB. Within that
 * constraint, `FINDASH_TEST_DB` lets parallel lanes (worktrees) each use
 * their own database — e.g. `findash_test_818` — so their DELETE-heavy
 * cleanup doesn't corrupt another lane's run.
 *
 * Two levels of isolation stack here, and they are independent (#912):
 *
 *   1. **Per lane** — `FINDASH_TEST_DB`, set by the operator. Isolates one
 *      worktree's whole run from another's.
 *   2. **Per worker** — appended automatically from `VITEST_POOL_ID`. Isolates
 *      one vitest worker from its siblings *inside* a single run, which is what
 *      lets the suite run with `fileParallelism` on at all. Without it, 258
 *      files sharing one database race on FK constraints and row counts — a
 *      non-deterministic 4-to-9 file failure, measured in #912.
 *
 * So a lane pinned to `findash_test_818` running four workers uses
 * `findash_test_818_w1 … _w4`, all cloned from `findash_test_818` itself by
 * `vitest.global-setup.ts`.
 */

const DEFAULT_TEST_DB_NAME = "findash_test";
const ALLOWED_PREFIX_RE = /^findash_test/;

/**
 * Resolves the *base* test database name from `FINDASH_TEST_DB`, falling back
 * to `findash_test` when unset. Throws if the override doesn't match
 * `/^findash_test/` — that's the only thing standing between tests and the
 * dev DB.
 *
 * This is the template every per-worker database is cloned from, and the one
 * `bun run db:migrate:test` / `db:seed:test` operate on. Test code never
 * connects to it directly during a parallel run.
 */
export function resolveBaseTestDbName(): string {
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

/**
 * Per-worker database name for a given pool id, cloned from the base database.
 *
 * Exported so `vitest.global-setup.ts` can create and drop exactly the names
 * the workers will later resolve, instead of reconstructing the suffix rule.
 */
export function workerDbName(baseName: string, poolId: number): string {
  return `${baseName}_w${poolId}`;
}

/**
 * Resolves the database name for the current process.
 *
 * Inside a vitest worker (`VITEST_POOL_ID` set) this is the worker's own
 * database. In the main process — globalSetup, or a single-threaded run — it
 * is the base database.
 *
 * The `findash_test` prefix guarantee holds in both branches: the suffix is
 * appended to an already-validated base name.
 */
export function resolveTestDbName(): string {
  const baseName = resolveBaseTestDbName();
  const poolId = process.env.VITEST_POOL_ID;

  if (!poolId) {
    return baseName;
  }

  const parsed = Number(poolId);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `[vitest] VITEST_POOL_ID="${poolId}" is not a positive integer. ` +
        `Refusing to guess which per-worker database to use.`,
    );
  }

  return workerDbName(baseName, parsed);
}
