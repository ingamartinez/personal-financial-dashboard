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
  investigateResidueForUser: vi.fn(),
  listResidueUserIds: vi.fn(),
}));

vi.mock("@/lib/classification/ask-user", () => ({
  processAskForUser: mocks.processAskForUser,
  listActiveAskUserIds: mocks.listActiveAskUserIds,
}));

vi.mock("@/lib/classification/investigate", () => ({
  investigateResidueForUser: mocks.investigateResidueForUser,
  listResidueUserIds: mocks.listResidueUserIds,
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

const emptyInvestigate = {
  considered: 0,
  classified: 0,
  inconclusive: 0,
  capped: 0,
  overBudget: 0,
  skippedIneligible: 0,
};

describe("classifyAskProcessor", () => {
  beforeEach(() => {
    mocks.processAskForUser.mockReset();
    mocks.listActiveAskUserIds.mockReset();
    mocks.investigateResidueForUser.mockReset();
    mocks.listResidueUserIds.mockReset();
    mocks.processAskForUser.mockResolvedValue({
      askedTxId: null,
      skipped: "no_eligible",
      expiredCount: 0,
      requeuedCount: 0,
    });
    mocks.investigateResidueForUser.mockResolvedValue(emptyInvestigate);
    mocks.listResidueUserIds.mockResolvedValue([]);
  });

  it("investigates a single user before asking, without listing others", async () => {
    mocks.processAskForUser.mockResolvedValueOnce({
      askedTxId: 12,
      skipped: null,
      expiredCount: 0,
      requeuedCount: 0,
    });
    const result = await classifyAskProcessor(mockJob({ mode: "single-user", userId: 7 }));
    expect(mocks.listActiveAskUserIds).not.toHaveBeenCalled();
    expect(mocks.listResidueUserIds).not.toHaveBeenCalled();
    expect(mocks.investigateResidueForUser).toHaveBeenCalledWith(7);
    expect(mocks.processAskForUser).toHaveBeenCalledWith(7);
    expect(mocks.investigateResidueForUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.processAskForUser.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({
      usersProcessed: 1,
      asked: 1,
      investigated: 0,
      failedUserIds: [],
      investigateFailures: [],
    });
  });

  it("unions ask users with residue users in all mode", async () => {
    mocks.listActiveAskUserIds.mockResolvedValueOnce([1]);
    mocks.listResidueUserIds.mockResolvedValueOnce([1, 2]);
    mocks.investigateResidueForUser
      .mockResolvedValueOnce({ ...emptyInvestigate, classified: 1 })
      .mockResolvedValueOnce(emptyInvestigate);
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
    expect(result.investigated).toBe(1);
    expect(result.failedUserIds).toEqual([]);
    expect(result.investigateFailures).toEqual([]);
    expect(mocks.investigateResidueForUser).toHaveBeenCalledTimes(2);
  });

  it("asks even when investigation throws", async () => {
    mocks.investigateResidueForUser.mockRejectedValueOnce(new Error("anthropic timeout"));
    mocks.processAskForUser.mockResolvedValueOnce({
      askedTxId: 42,
      skipped: null,
      expiredCount: 0,
      requeuedCount: 0,
    });
    const result = await classifyAskProcessor(mockJob({ mode: "single-user", userId: 7 }));
    expect(mocks.processAskForUser).toHaveBeenCalledWith(7);
    expect(result.asked).toBe(1);
    expect(result.usersProcessed).toBe(1);
    expect(result.failedUserIds).toEqual([]);
    expect(result.investigated).toBe(0);
    expect(result.investigateFailures).toEqual([{ userId: 7 }]);
  });

  it("does not report a clean result when investigation throws", async () => {
    const err = Object.assign(new Error("anthropic timeout"), { txId: 99 });
    mocks.investigateResidueForUser.mockRejectedValueOnce(err);
    mocks.processAskForUser.mockResolvedValueOnce({
      askedTxId: 42,
      skipped: null,
      expiredCount: 0,
      requeuedCount: 0,
    });
    const job = mockJob({ mode: "single-user", userId: 7 });
    const result = await classifyAskProcessor(job);
    expect(mocks.processAskForUser).toHaveBeenCalledWith(7);
    expect(result.asked).toBe(1);
    expect(result.failedUserIds).toEqual([]);
    expect(result.investigateFailures).toEqual([{ userId: 7, txId: 99 }]);
    expect(job.log).toHaveBeenCalledWith("userId=7 investigate_failed txId=99");
  });

  it("isolates an ask failure and continues", async () => {
    mocks.listActiveAskUserIds.mockResolvedValueOnce([1, 2]);
    mocks.investigateResidueForUser.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      ...emptyInvestigate,
      classified: 1,
    });
    mocks.processAskForUser
      .mockRejectedValueOnce(new Error("telegram down"))
      .mockResolvedValueOnce({
        askedTxId: 3,
        skipped: null,
        expiredCount: 0,
        requeuedCount: 0,
      });
    const result = await classifyAskProcessor(mockJob({ mode: "all" }));
    expect(mocks.processAskForUser).toHaveBeenCalledTimes(2);
    expect(result.failedUserIds).toEqual([1]);
    expect(result.investigateFailures).toEqual([{ userId: 1 }]);
    expect(result.usersProcessed).toBe(1);
    expect(result.asked).toBe(1);
    expect(result.investigated).toBe(1);
  });
});
