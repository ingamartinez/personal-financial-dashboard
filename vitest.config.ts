import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
    testTimeout: 10_000,
    setupFiles: ["./vitest.setup.ts"],
    // Integration tests share a single Postgres database and INSERT/DELETE
    // rows during setup/cleanup. Running test files in parallel races on
    // FK constraints and row counts. Serialize at the file level.
    fileParallelism: false,
  },
});
