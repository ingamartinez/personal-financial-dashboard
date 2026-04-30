// #667: Tests for the rule-proposals BullMQ worker processor.
// These are unit-style tests — detectAndEnqueueRuleProposals and emitNotification
// are both mocked. No DB access.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted BEFORE any imports that resolve the modules.
// ---------------------------------------------------------------------------

vi.mock("@/lib/queue", () => ({
  createWorker: vi.fn().mockReturnValue({
    on: vi.fn(),
    close: vi.fn(),
  }),
}));

const mocks = vi.hoisted(() => ({
  detectAndEnqueueRuleProposals: vi.fn(),
  emitNotification: vi.fn(),
}));

vi.mock("@/lib/classification/proposals", () => ({
  detectAndEnqueueRuleProposals: mocks.detectAndEnqueueRuleProposals,
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

// ---------------------------------------------------------------------------
// Lazy import (after mocks are wired)
// ---------------------------------------------------------------------------

const { ruleProposalsProcessor } = await import("./rule-proposals");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockJob(): Job {
  return {
    id: "test-job-667",
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ruleProposalsProcessor", () => {
  beforeEach(() => {
    mocks.detectAndEnqueueRuleProposals.mockReset();
    mocks.emitNotification.mockReset();
    mocks.emitNotification.mockResolvedValue({ id: 99 });
  });

  it("calls detectAndEnqueueRuleProposals and returns summary with zeros when nothing detected", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 0,
      inserted: 0,
      skipped: 0,
      proposals: [],
    });

    const result = await ruleProposalsProcessor(mockJob());

    expect(mocks.detectAndEnqueueRuleProposals).toHaveBeenCalledOnce();
    expect(result).toEqual({ scanned: 0, inserted: 0, skipped: 0, emitted: 0 });
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("emits one notification per proposal with the correct payload", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 2,
      inserted: 2,
      skipped: 0,
      proposals: [
        { id: 10, userId: 1, merchant: "RAPPI", categorySlug: "alimentacion" },
        { id: 11, userId: 2, merchant: "NETFLIX", categorySlug: "entretenimiento" },
      ],
    });

    const result = await ruleProposalsProcessor(mockJob());

    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);

    const [call1UserId, call1Input] = mocks.emitNotification.mock.calls[0] as [
      number,
      {
        type: string;
        entityId: string;
        priority: string;
        title: string;
        actionUrl: string;
        metadata: { proposalId: number; merchant: string; categorySlug: string };
      },
    ];
    expect(call1UserId).toBe(1);
    expect(call1Input.type).toBe("rule_proposal_ready");
    expect(call1Input.entityId).toBe("10");
    expect(call1Input.priority).toBe("medium");
    expect(call1Input.actionUrl).toBe("/settings/rules/proposals");
    expect(call1Input.metadata.proposalId).toBe(10);
    expect(call1Input.metadata.merchant).toBe("RAPPI");
    expect(call1Input.metadata.categorySlug).toBe("alimentacion");

    const [call2UserId, call2Input] = mocks.emitNotification.mock.calls[1] as [
      number,
      { type: string; entityId: string; metadata: { proposalId: number } },
    ];
    expect(call2UserId).toBe(2);
    expect(call2Input.entityId).toBe("11");
    expect(call2Input.metadata.proposalId).toBe(11);

    expect(result.emitted).toBe(2);
    expect(result.inserted).toBe(2);
  });

  it("counts emitted correctly and logs errors when emitNotification rejects for one proposal", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 3,
      inserted: 2,
      skipped: 1,
      proposals: [
        { id: 20, userId: 5, merchant: "UBER", categorySlug: "transporte" },
        { id: 21, userId: 6, merchant: "SPOTIFY", categorySlug: "entretenimiento" },
      ],
    });

    // First emitNotification succeeds, second rejects.
    mocks.emitNotification
      .mockResolvedValueOnce({ id: 200 })
      .mockRejectedValueOnce(new Error("DB connection lost"));

    const result = await ruleProposalsProcessor(mockJob());

    // Should not throw — Promise.allSettled handles rejections.
    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);
    expect(result.emitted).toBe(1); // only the successful one
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it("updates job progress at start and done", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 1,
      inserted: 1,
      skipped: 0,
      proposals: [{ id: 30, userId: 7, merchant: "AMAZON", categorySlug: "compras" }],
    });

    const job = mockJob();
    await ruleProposalsProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "detecting" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "emitting" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });

  it("notification body includes merchant and categorySlug", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 1,
      inserted: 1,
      skipped: 0,
      proposals: [{ id: 40, userId: 8, merchant: "TOSTAO", categorySlug: "cafe" }],
    });

    await ruleProposalsProcessor(mockJob());

    const [, input] = mocks.emitNotification.mock.calls[0] as [
      number,
      { body: string; title: string },
    ];
    expect(input.title).toBe("Nueva regla sugerida");
    expect(input.body).toContain("TOSTAO");
    expect(input.body).toContain("cafe");
  });
});
