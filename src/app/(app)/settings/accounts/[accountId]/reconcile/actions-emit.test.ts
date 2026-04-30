// Unit tests for reconciliation emitters — Wave 1 (#657) + Wave 3 (#662).
// Covers reconciliation_flagged_txns and statement_import_complete.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as emitModule from "@/lib/notifications/emit";

// ── module mocks (hoisted) ────────────────────────────────────────────────

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const sessionMock = { id: 42, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

vi.mock("@/lib/reconciliation/commit", () => ({
  commitReconciliation: vi.fn(),
  hashFileBuffer: vi.fn().mockReturnValue("a".repeat(64)),
  recordReconciliationDecision: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/reconciliation/dispatch", () => ({
  parseAny: vi.fn().mockReturnValue({
    detected: { bank: "bancolombia" },
    parsed: {
      format: "bancolombia_savings",
      periodStart: new Date("2026-04-01"),
      periodEnd: new Date("2026-04-30"),
      rows: [],
    },
  }),
}));

vi.mock("@/lib/reconciliation/engine/match", () => ({
  matchStatement: vi.fn().mockReturnValue({
    toInsert: [],
    toMatch: [],
    flaggedExisting: [],
  }),
}));

vi.mock("@/lib/reconciliation/pago-tc-router", () => ({
  applyPagoTcRouting: vi.fn().mockResolvedValue({ routed: 0, skipped: 0 }),
}));

vi.mock("@/lib/classification/enqueue", () => ({
  classifyByRuleThenEnqueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: 7,
              institutionSlug: "bancolombia",
              currency: "COP",
              physicalCardId: null,
            },
          ]),
        }),
      }),
    }),
  },
}));

vi.mock("./window", () => ({
  expandReconcileWindow: vi.fn().mockReturnValue({
    windowStart: new Date("2026-03-29"),
    windowEnd: new Date("2026-04-30"),
  }),
}));

// ── tests ─────────────────────────────────────────────────────────────────

describe("applyReconcile — reconciliation_flagged_txns emitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits reconciliation_flagged_txns once when flagged > 0", async () => {
    const { commitReconciliation } = await import("@/lib/reconciliation/commit");
    (commitReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "applied",
      inserted: 0,
      insertedIds: [],
      matched: 2,
      flagged: 3,
      statementImportId: 55,
    });

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { applyReconcile } = await import("./actions");
    await applyReconcile({
      accountId: 7,
      fileHash: "a".repeat(64),
      parsed: {
        format: "bancolombia_savings",
        periodStart: "2026-04-01T00:00:00.000Z",
        periodEnd: "2026-04-30T00:00:00.000Z",
        rows: [],
      },
      plan: { toInsert: [], toMatch: [], flaggedExisting: [] },
      userBalanceAtEndCents: null,
    });

    // Both statement_import_complete (#662) and reconciliation_flagged_txns (#657) fire
    // when status=applied and flagged > 0.
    const flaggedCall = spy.mock.calls.find(
      ([, input]) => input.type === "reconciliation_flagged_txns",
    );
    expect(flaggedCall).toBeDefined();
    expect(flaggedCall![1]).toMatchObject({
      type: "reconciliation_flagged_txns",
      entityId: "55",
      audience: "user",
      priority: "high",
    });
  });

  it("does NOT emit reconciliation_flagged_txns when flagged === 0", async () => {
    const { commitReconciliation } = await import("@/lib/reconciliation/commit");
    (commitReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "applied",
      inserted: 5,
      insertedIds: [1, 2, 3, 4, 5],
      matched: 0,
      flagged: 0,
      statementImportId: 56,
    });

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { applyReconcile } = await import("./actions");
    await applyReconcile({
      accountId: 7,
      fileHash: "a".repeat(64),
      parsed: {
        format: "bancolombia_savings",
        periodStart: "2026-04-01T00:00:00.000Z",
        periodEnd: "2026-04-30T00:00:00.000Z",
        rows: [],
      },
      plan: { toInsert: [], toMatch: [], flaggedExisting: [] },
      userBalanceAtEndCents: null,
    });

    // statement_import_complete fires (flagged=0 still applied), but NOT reconciliation_flagged_txns
    const flaggedCall = spy.mock.calls.find(
      ([, input]) => input.type === "reconciliation_flagged_txns",
    );
    expect(flaggedCall).toBeUndefined();
  });

  it("does NOT emit when result.status is not 'applied'", async () => {
    const { commitReconciliation } = await import("@/lib/reconciliation/commit");
    (commitReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "already_imported",
      inserted: 0,
      insertedIds: [],
      matched: 0,
      flagged: 5,
      statementImportId: 57,
    });

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { applyReconcile } = await import("./actions");
    await applyReconcile({
      accountId: 7,
      fileHash: "a".repeat(64),
      parsed: {
        format: "bancolombia_savings",
        periodStart: "2026-04-01T00:00:00.000Z",
        periodEnd: "2026-04-30T00:00:00.000Z",
        rows: [],
      },
      plan: { toInsert: [], toMatch: [], flaggedExisting: [] },
      userBalanceAtEndCents: null,
    });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("applyReconcile — statement_import_complete emitter (#662)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits statement_import_complete once when result.status is 'applied'", async () => {
    const { commitReconciliation } = await import("@/lib/reconciliation/commit");
    (commitReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "applied",
      inserted: 4,
      insertedIds: [10, 11, 12, 13],
      matched: 1,
      flagged: 0,
      statementImportId: 88,
    });

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { applyReconcile } = await import("./actions");
    await applyReconcile({
      accountId: 7,
      fileHash: "a".repeat(64),
      parsed: {
        format: "bancolombia_savings",
        periodStart: "2026-04-01T00:00:00.000Z",
        periodEnd: "2026-04-30T00:00:00.000Z",
        rows: [],
      },
      plan: { toInsert: [], toMatch: [], flaggedExisting: [] },
      userBalanceAtEndCents: null,
    });

    // statement_import_complete should have been emitted (once)
    const statementCall = spy.mock.calls.find(
      ([, input]) => input.type === "statement_import_complete",
    );
    expect(statementCall).toBeDefined();
    expect(statementCall![1]).toMatchObject({
      type: "statement_import_complete",
      entityId: "88",
      priority: "medium",
    });
  });

  it("does NOT emit statement_import_complete when status is 'already_imported'", async () => {
    const { commitReconciliation } = await import("@/lib/reconciliation/commit");
    (commitReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "already_imported",
      inserted: 0,
      insertedIds: [],
      matched: 0,
      flagged: 0,
      statementImportId: 89,
    });

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { applyReconcile } = await import("./actions");
    await applyReconcile({
      accountId: 7,
      fileHash: "a".repeat(64),
      parsed: {
        format: "bancolombia_savings",
        periodStart: "2026-04-01T00:00:00.000Z",
        periodEnd: "2026-04-30T00:00:00.000Z",
        rows: [],
      },
      plan: { toInsert: [], toMatch: [], flaggedExisting: [] },
      userBalanceAtEndCents: null,
    });

    const statementCall = spy.mock.calls.find(
      ([, input]) => input.type === "statement_import_complete",
    );
    expect(statementCall).toBeUndefined();
  });
});
