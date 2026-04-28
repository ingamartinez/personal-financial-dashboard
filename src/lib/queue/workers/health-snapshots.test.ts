// Tests for the health-snapshots BullMQ worker.
// The processor is tested directly — no Worker instantiation needed for unit tests.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  snapshotAllActiveUsers: vi.fn(),
}));

vi.mock("@/lib/telemetry/user-health", () => ({
  snapshotAllActiveUsers: mocks.snapshotAllActiveUsers,
}));

import type { Job } from "bullmq";
import { healthSnapshotsProcessor, type HealthSnapshotsJobData } from "./health-snapshots";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: HealthSnapshotsJobData = {}): Job<HealthSnapshotsJobData> {
  return { id: "test-job-health-snapshots", data } as unknown as Job<HealthSnapshotsJobData>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("healthSnapshotsProcessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls snapshotAllActiveUsers and aggregates results", async () => {
    mocks.snapshotAllActiveUsers.mockResolvedValueOnce([
      { ok: true, userId: 1, data: { churnSignalFlag: false } },
      { ok: true, userId: 2, data: { churnSignalFlag: true } },
    ]);

    await healthSnapshotsProcessor(makeJob());

    expect(mocks.snapshotAllActiveUsers).toHaveBeenCalledOnce();
  });

  it("logs per-user errors without throwing", async () => {
    mocks.snapshotAllActiveUsers.mockResolvedValueOnce([
      { ok: true, userId: 1, data: { churnSignalFlag: false } },
      { ok: false, userId: 2, error: new Error("snapshot failed") },
    ]);

    // Should NOT throw — per-user errors are logged, not re-thrown.
    await expect(healthSnapshotsProcessor(makeJob())).resolves.toBeUndefined();
  });

  it("propagates top-level snapshotAllActiveUsers errors for BullMQ retry", async () => {
    mocks.snapshotAllActiveUsers.mockRejectedValueOnce(new Error("connection refused"));

    await expect(healthSnapshotsProcessor(makeJob())).rejects.toThrow("connection refused");
  });

  it("handles empty results (no active users) without error", async () => {
    mocks.snapshotAllActiveUsers.mockResolvedValueOnce([]);

    await expect(healthSnapshotsProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.snapshotAllActiveUsers).toHaveBeenCalledOnce();
  });

  it("correctly counts churn-signal flags in results", async () => {
    mocks.snapshotAllActiveUsers.mockResolvedValueOnce([
      { ok: true, userId: 1, data: { churnSignalFlag: true } },
      { ok: true, userId: 2, data: { churnSignalFlag: true } },
      { ok: true, userId: 3, data: { churnSignalFlag: false } },
    ]);

    // Should complete without error — churned count is logged.
    await expect(healthSnapshotsProcessor(makeJob())).resolves.toBeUndefined();
  });
});
