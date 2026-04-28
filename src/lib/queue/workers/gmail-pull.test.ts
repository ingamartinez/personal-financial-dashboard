// Tests for the gmail-pull BullMQ worker.
// The processor is tested directly — no Worker instantiation needed for unit tests.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  pullForUser: vi.fn(),
  pullAllActiveConnections: vi.fn(),
}));

vi.mock("@/lib/gmail/pull", () => ({
  pullForUser: mocks.pullForUser,
  pullAllActiveConnections: mocks.pullAllActiveConnections,
}));

import type { Job } from "bullmq";
import { gmailPullProcessor, type GmailPullJobData } from "./gmail-pull";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: GmailPullJobData): Job<GmailPullJobData> {
  return { id: "test-job-gmail-pull", data } as unknown as Job<GmailPullJobData>;
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

    await expect(
      gmailPullProcessor(makeJob({ mode: "single-user", userId: 1 })),
    ).rejects.toThrow("Gmail API timeout");
  });
});
