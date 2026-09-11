import { defineConfig } from "vitest/config";

import { resolveMaxWorkers } from "./vitest.workers";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
    testTimeout: 10_000,
    setupFiles: ["./vitest.setup.ts"],
    // Creates one database per worker before the suite and drops them after.
    // See vitest.global-setup.ts — that clone step is what makes the parallel
    // run below safe, so the two settings must move together.
    globalSetup: ["./vitest.global-setup.ts"],
    // Integration tests INSERT/DELETE rows during setup/cleanup, so they cannot
    // share one database: running them against a single findash_test races on
    // FK constraints and row counts (#912 measured a non-deterministic 4-to-9
    // file failure). The fix is isolation, not serialization — each worker gets
    // its own cloned database via VITEST_POOL_ID, so file parallelism is safe.
    //
    // Do NOT set `fileParallelism: false` to work around a flaky test. That
    // trades the whole suite's wall-clock (87s serial vs ~13s parallel, locally)
    // for a symptom fix, and hides whatever real cross-test coupling caused it.
    maxWorkers: resolveMaxWorkers(),
  },
});
