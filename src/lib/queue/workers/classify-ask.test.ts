import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClassifyAskJobData } from "./classify-ask";

vi.mock("@/lib/queue", () => ({
  createWorker: vi.fn().mockReturnValue({
    on: vi.fn(),
    close: vi.fn(),
  }),
}));

const mocks = vi.hoisted(() => ({
  processAskForUser: vi.fn(),
  listActiveAskUserIds: vi.fn(),
}));

vi.mock("@/lib/classification/ask-user", () => ({
  processAskForUser: mocks.processAskForUser,
  listActiveAskUserIds: mocks.listActiveAskUserIds,
}));

const { classifyAskProcessor } = await import("./classify-ask");

function mockJob(data: ClassifyAskJobData): Job<ClassifyAskJobData> {
  return {
    id: "test-job-ask",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<ClassifyAskJobData>;
}

describe("classifyAskProcessor", () => {
  beforeEach(() => {
    mocks.processAskForUser.mockReset();
    mocks.listActiveAskUserIds.mockReset();
    mocks.processAskForUser.mockResolvedValue({
      askedTxId: null,
      skipped: "no_eligible",
      expiredCount: 0,
      requeuedCount: 0,
    });
  });

  it("processes a single user without listing others", async () => {
    mocks.processAskForUser.mockResolvedValueOnce({
      askedTxId: 12,
      skipped: null,
      expiredCount: 0,
      requeuedCount: 0,
    });
    const result = await classifyAskProcessor(mockJob({ mode: "single-user", userId: 7 }));
    expect(mocks.listActiveAskUserIds).not.toHaveBeenCalled();
    expect(mocks.processAskForUser).toHaveBeenCalledWith(7);
    expect(result).toEqual({ usersProcessed: 1, asked: 1, failedUserIds: [] });
  });

  it("fans out over listActiveAskUserIds in all mode", async () => {
    mocks.listActiveAskUserIds.mockResolvedValueOnce([1, 2]);
    mocks.processAskForUser
      .mockResolvedValueOnce({
        askedTxId: 10,
        skipped: null,
        expiredCount: 0,
        requeuedCount: 0,
      })
      .mockResolvedValueOnce({
        askedTxId: null,
        skipped: "outstanding",
        expiredCount: 1,
        requeuedCount: 0,
      });
    const result = await classifyAskProcessor(mockJob({ mode: "all" }));
    expect(result.usersProcessed).toBe(2);
    expect(result.asked).toBe(1);
    expect(result.failedUserIds).toEqual([]);
  });

  it("isolates a user failure and continues", async () => {
    mocks.listActiveAskUserIds.mockResolvedValueOnce([1, 2]);
    mocks.processAskForUser.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      askedTxId: 3,
      skipped: null,
      expiredCount: 0,
      requeuedCount: 0,
    });
    const result = await classifyAskProcessor(mockJob({ mode: "all" }));
    expect(result.failedUserIds).toEqual([1]);
    expect(result.usersProcessed).toBe(1);
    expect(result.asked).toBe(1);
  });
});
