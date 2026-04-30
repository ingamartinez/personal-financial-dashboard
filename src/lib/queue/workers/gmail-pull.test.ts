// Tests for the gmail-pull BullMQ worker.
// The processor is tested directly — no Worker instantiation needed for unit tests.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  pullForUser: vi.fn(),
  pullAllActiveConnections: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/lib/gmail/pull", () => ({
  pullForUser: mocks.pullForUser,
  pullAllActiveConnections: mocks.pullAllActiveConnections,
}));

vi.mock("@/lib/events/bus", () => ({
  emit: mocks.emit,
}));

import type { Job } from "bullmq";
import { gmailPullProcessor, type GmailPullJobData } from "./gmail-pull";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: GmailPullJobData): Job<GmailPullJobData> {
  return {
    id: "test-job-gmail-pull",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<GmailPullJobData>;
}

const emptyResult = {
  userId: 1,
  pulled: 0,
  skipped: 0,
  byGateway: {},
  errors: [],
  connectionId: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gmailPullProcessor — mode: all", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls pullAllActiveConnections for all-mode cron tick", async () => {
    mocks.pullAllActiveConnections.mockResolvedValueOnce([
      { ...emptyResult, userId: 1, pulled: 5, skipped: 2 },
      { ...emptyResult, userId: 2, pulled: 3, skipped: 0 },
    ]);

    await gmailPullProcessor(makeJob({ mode: "all" }));

    expect(mocks.pullAllActiveConnections).toHaveBeenCalledOnce();
    expect(mocks.pullAllActiveConnections).toHaveBeenCalledWith({}, {});
    expect(mocks.pullForUser).not.toHaveBeenCalled();
  });

  it("forwards PullOpts to pullAllActiveConnections", async () => {
    mocks.pullAllActiveConnections.mockResolvedValueOnce([]);

    await gmailPullProcessor(makeJob({ mode: "all", opts: { sinceDays: 7 } }));

    expect(mocks.pullAllActiveConnections).toHaveBeenCalledWith({}, { sinceDays: 7 });
  });

  it("handles empty connections list without throwing", async () => {
    mocks.pullAllActiveConnections.mockResolvedValueOnce([]);

    await expect(gmailPullProcessor(makeJob({ mode: "all" }))).resolves.toBeUndefined();
  });

  it("propagates top-level pullAllActiveConnections errors for BullMQ retry", async () => {
    mocks.pullAllActiveConnections.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(gmailPullProcessor(makeJob({ mode: "all" }))).rejects.toThrow(
      "DB connection lost",
    );
  });

  it("completes even when some users have errors (logs but does not throw)", async () => {
    mocks.pullAllActiveConnections.mockResolvedValueOnce([
      { ...emptyResult, userId: 1, pulled: 0, errors: [{ type: "auth", message: "revoked" }] },
      { ...emptyResult, userId: 2, pulled: 10, errors: [] },
    ]);

    await expect(gmailPullProcessor(makeJob({ mode: "all" }))).resolves.toBeUndefined();
  });
});

describe("gmailPullProcessor — mode: single-user", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls pullForUser with the correct userId", async () => {
    mocks.pullForUser.mockResolvedValueOnce({ ...emptyResult, userId: 42, pulled: 3, skipped: 1 });

    await gmailPullProcessor(makeJob({ mode: "single-user", userId: 42 }));

    expect(mocks.pullForUser).toHaveBeenCalledOnce();
    expect(mocks.pullForUser).toHaveBeenCalledWith(42, {});
    expect(mocks.pullAllActiveConnections).not.toHaveBeenCalled();
  });

  it("forwards PullOpts to pullForUser", async () => {
    mocks.pullForUser.mockResolvedValueOnce({ ...emptyResult, userId: 7 });

    await gmailPullProcessor(
      makeJob({ mode: "single-user", userId: 7, opts: { overrideSince: new Date("2026-01-01") } }),
    );

    expect(mocks.pullForUser).toHaveBeenCalledWith(7, { overrideSince: new Date("2026-01-01") });
  });

  it("propagates pullForUser errors for BullMQ retry", async () => {
    mocks.pullForUser.mockRejectedValueOnce(new Error("Gmail API timeout"));

    await expect(gmailPullProcessor(makeJob({ mode: "single-user", userId: 1 }))).rejects.toThrow(
      "Gmail API timeout",
    );
  });

  it("calls updateProgress at start and done — Bull-Board contract", async () => {
    mocks.pullForUser.mockResolvedValueOnce({ ...emptyResult, userId: 5, pulled: 4, skipped: 1 });

    const job = makeJob({ mode: "single-user", userId: 5 });
    await gmailPullProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, phase: "auth" }),
    );
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });
});

describe("gmailPullProcessor — mode: all — Bull-Board contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls updateProgress at start and done", async () => {
    mocks.pullAllActiveConnections.mockResolvedValueOnce([
      { ...emptyResult, userId: 1, pulled: 3 },
    ]);

    const job = makeJob({ mode: "all" });
    await gmailPullProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ users: 0 }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bus emit — single-user emits job:progress + job:done; all mode does NOT
// ---------------------------------------------------------------------------

describe("bus emit — single-user mode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("emits job:progress (phase=pulling) then job:done with correct counts", async () => {
    mocks.pullForUser.mockResolvedValueOnce({
      ...emptyResult,
      userId: 42,
      pulled: 7,
      skipped: 3,
    });

    await gmailPullProcessor(makeJob({ mode: "single-user", userId: 42 }));

    const progressCalls = mocks.emit.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "job:progress",
    );
    const doneCalls = mocks.emit.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "job:done",
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0][0]).toMatchObject({
      type: "job:progress",
      jobName: "gmail-pull",
      jobId: "test-job-gmail-pull",
      userId: 42,
      phase: "pulling",
    });

    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][0]).toMatchObject({
      type: "job:done",
      jobName: "gmail-pull",
      jobId: "test-job-gmail-pull",
      userId: 42,
      newTxCount: 7,
      processedCount: 10, // pulled(7) + skipped(3)
    });
  });
});

describe("bus emit — all mode does NOT emit job:* events", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("does not emit any bus events in all mode", async () => {
    mocks.pullAllActiveConnections.mockResolvedValueOnce([
      { ...emptyResult, userId: 1, pulled: 5 },
    ]);

    await gmailPullProcessor(makeJob({ mode: "all" }));

    const jobEvents = mocks.emit.mock.calls.filter((args) =>
      (args[0] as { type: string }).type.startsWith("job:"),
    );
    expect(jobEvents).toHaveLength(0);
  });
});
