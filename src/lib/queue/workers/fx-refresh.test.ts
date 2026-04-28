// Tests for the fx-refresh BullMQ worker.
// Requires a real Redis instance at REDIS_URL (default: localhost:6379).
// The processor is tested directly (no Worker instantiation needed for unit tests).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  fetchTrm: vi.fn(),
  upsertFxRate: vi.fn(),
}));

vi.mock("@/lib/fx/trm", () => ({
  fetchTrm: mocks.fetchTrm,
}));

vi.mock("@/lib/fx/repo", () => ({
  upsertFxRate: mocks.upsertFxRate,
  getCurrentFxRate: vi.fn(),
}));

import type { Job } from "bullmq";
import { fxRefreshProcessor, type FxRefreshJobData } from "./fx-refresh";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: FxRefreshJobData = {}): Job<FxRefreshJobData> {
  return { id: "test-job-1", data } as unknown as Job<FxRefreshJobData>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fxRefreshProcessor", () => {
  beforeAll(() => {
    // nothing — mocks are set up via vi.mock above
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("fetches TRM and upserts the rate into fx_rates", async () => {
    mocks.fetchTrm.mockResolvedValueOnce({
      rate: 4200.5,
      asOf: "2026-04-28",
      source: "trm",
    });
    mocks.upsertFxRate.mockResolvedValueOnce(undefined);

    await fxRefreshProcessor(makeJob());

    expect(mocks.fetchTrm).toHaveBeenCalledOnce();
    expect(mocks.upsertFxRate).toHaveBeenCalledOnce();
    expect(mocks.upsertFxRate).toHaveBeenCalledWith({
      base: "USD",
      quote: "COP",
      rate: 4200.5,
      asOf: "2026-04-28",
      source: "trm",
    });
  });

  it("propagates fetchTrm errors so BullMQ can retry", async () => {
    mocks.fetchTrm.mockRejectedValueOnce(new Error("TRM API error 503"));

    await expect(fxRefreshProcessor(makeJob())).rejects.toThrow("TRM API error 503");
    expect(mocks.upsertFxRate).not.toHaveBeenCalled();
  });

  it("propagates upsertFxRate errors so BullMQ can retry", async () => {
    mocks.fetchTrm.mockResolvedValueOnce({
      rate: 4100,
      asOf: "2026-04-27",
      source: "trm",
    });
    mocks.upsertFxRate.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(fxRefreshProcessor(makeJob())).rejects.toThrow("DB connection lost");
  });

  it("passes the job reason through to the processor context (boot-backfill)", async () => {
    mocks.fetchTrm.mockResolvedValueOnce({
      rate: 4300,
      asOf: "2026-04-28",
      source: "trm",
    });
    mocks.upsertFxRate.mockResolvedValueOnce(undefined);

    // Should complete without error regardless of the reason tag.
    await expect(fxRefreshProcessor(makeJob({ reason: "boot-backfill" }))).resolves.toBeUndefined();
    expect(mocks.upsertFxRate).toHaveBeenCalledOnce();
  });
});
