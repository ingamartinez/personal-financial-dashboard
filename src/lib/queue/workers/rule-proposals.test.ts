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
  synthesizeRuleProposals: vi.fn(),
  emitNotification: vi.fn(),
}));

vi.mock("@/lib/classification/proposals", () => ({
  detectAndEnqueueRuleProposals: mocks.detectAndEnqueueRuleProposals,
}));

vi.mock("@/lib/classification/synthesize-rules", () => ({
  synthesizeRuleProposals: mocks.synthesizeRuleProposals,
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
    mocks.synthesizeRuleProposals.mockReset();
    mocks.emitNotification.mockReset();
    mocks.emitNotification.mockResolvedValue({ id: 99 });
    mocks.synthesizeRuleProposals.mockResolvedValue({
      usersScanned: 0,
      inserted: 0,
      skipped: 0,
      proposals: [],
    });
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
    expect(result).toEqual({ scanned: 0, inserted: 0, skipped: 0, emitted: 0, synthesized: 0 });
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("emits one notification per proposal with the correct payload", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 2,
      inserted: 2,
      skipped: 0,
      proposals: [
        {
          id: 10,
          userId: 1,
          merchant: "RAPPI",
          pattern: "%RAPPI%",
          categorySlug: "alimentacion",
          source: "corrections",
        },
        {
          id: 11,
          userId: 2,
          merchant: "NETFLIX",
          pattern: "%NETFLIX%",
          categorySlug: "entretenimiento",
          source: "corrections",
        },
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
        {
          id: 20,
          userId: 5,
          merchant: "UBER",
          pattern: "%UBER%",
          categorySlug: "transporte",
          source: "corrections",
        },
        {
          id: 21,
          userId: 6,
          merchant: "SPOTIFY",
          pattern: "%SPOTIFY%",
          categorySlug: "entretenimiento",
          source: "corrections",
        },
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
      proposals: [
        {
          id: 30,
          userId: 7,
          merchant: "AMAZON",
          pattern: "%AMAZON%",
          categorySlug: "compras",
          source: "corrections",
        },
      ],
    });

    const job = mockJob();
    await ruleProposalsProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "detecting" }),
    );
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "emitting" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });

  it("notification body includes merchant and categorySlug", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 1,
      inserted: 1,
      skipped: 0,
      proposals: [
        {
          id: 40,
          userId: 8,
          merchant: "TOSTAO",
          pattern: "%TOSTAO%",
          categorySlug: "cafe",
          source: "corrections",
        },
      ],
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

  it("emits synthesized proposals using the stored pattern, not a merchant wrap", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 0,
      inserted: 0,
      skipped: 0,
      proposals: [],
    });
    mocks.synthesizeRuleProposals.mockResolvedValue({
      usersScanned: 1,
      inserted: 1,
      skipped: 0,
      proposals: [
        {
          id: 50,
          userId: 9,
          merchant: "UBER TRIP",
          pattern: "%SYNUBER%",
          categorySlug: "uber-didi",
          source: "synthesized",
        },
      ],
    });

    const result = await ruleProposalsProcessor(mockJob());

    expect(result.synthesized).toBe(1);
    expect(result.emitted).toBe(1);
    const [, input] = mocks.emitNotification.mock.calls[0] as [
      number,
      { body: string; metadata: { pattern: string; source: string } },
    ];
    expect(input.body).toContain("%SYNUBER%");
    expect(input.body).not.toContain("%UBER TRIP%");
    expect(input.metadata.pattern).toBe("%SYNUBER%");
    expect(input.metadata.source).toBe("synthesized");
  });

  it("still returns correction proposals when synthesis throws", async () => {
    mocks.detectAndEnqueueRuleProposals.mockResolvedValue({
      scanned: 1,
      inserted: 1,
      skipped: 0,
      proposals: [
        {
          id: 60,
          userId: 10,
          merchant: "CARULLA",
          pattern: "%CARULLA%",
          categorySlug: "mercado",
          source: "corrections",
        },
      ],
    });
    mocks.synthesizeRuleProposals.mockRejectedValue(new Error("anthropic timeout"));

    const result = await ruleProposalsProcessor(mockJob());

    expect(result.inserted).toBe(1);
    expect(result.synthesized).toBe(0);
    expect(result.emitted).toBe(1);
  });
});
