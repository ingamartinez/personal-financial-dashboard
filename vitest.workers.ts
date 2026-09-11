/**
 * Worker-count resolution, shared by `vitest.config.ts` and
 * `vitest.global-setup.ts`.
 *
 * Both files need the SAME number: the config uses it to cap the worker pool,
 * and globalSetup uses it to decide how many per-worker databases to
 * materialize (see `vitest.test-db-name.ts`). If they ever disagree, a worker
 * whose pool id exceeds the database count connects to a database that was
 * never created and the run fails on a confusing connection error rather than
 * a clear one — so the number lives here once instead of twice.
 *
 * Vitest assigns `VITEST_POOL_ID` as a 1-based *slot* index and reuses slots
 * across files, so the slot count — not the file count — bounds how many
 * databases are needed.
 */

import { availableParallelism } from "node:os";

/** Hard ceiling. Past this, Postgres connection setup costs more than the
 *  extra concurrency returns, and every extra worker is another database to
 *  clone during globalSetup. */
const MAX_WORKERS_CEILING = 8;

/**
 * Resolves the vitest worker-pool size.
 *
 * `VITEST_MAX_WORKERS` overrides it — CI pins this so the number of databases
 * cloned per run does not drift with whatever runner size GitHub hands out.
 */
export function resolveMaxWorkers(): number {
  const override = process.env.VITEST_MAX_WORKERS;

  if (override) {
    const parsed = Number(override);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `[vitest] VITEST_MAX_WORKERS="${override}" is not a positive integer. ` +
          `Refusing to guess a worker count.`,
      );
    }
    return parsed;
  }

  // Leave one core for the main process and the Postgres server itself.
  return Math.max(1, Math.min(MAX_WORKERS_CEILING, availableParallelism() - 1));
}
