/**
 * Unit tests for FxMetadata backfill logic.
 * Tests the core idempotency behavior: valid blocks are skipped, invalid ones are replaced.
 */
import { describe, it, expect } from "vitest";
import { parseFxMetadata } from "./fx-metadata";

// Simulate what the backfill script does: detect whether a tx needs backfill.
function needsBackfill(rawData: Record<string, unknown> | null): boolean {
  if (!rawData) return true;
  const fx = rawData.fx;
  if (fx === undefined || fx === null) return true;
  return parseFxMetadata(fx) === null;
}

describe("backfill idempotency logic", () => {
  it("tx with no rawData needs backfill", () => {
    expect(needsBackfill(null)).toBe(true);
  });

  it("tx with rawData but no fx block needs backfill", () => {
    expect(needsBackfill({ kind: "purchase" })).toBe(true);
  });

  it("tx with valid COP fx block does NOT need backfill", () => {
    expect(
      needsBackfill({
        fx: {
          originalCurrency: "COP",
          originalAmountCents: "50000",
          trmToAccountCurrency: null,
          trmSource: "1_to_1",
        },
      }),
    ).toBe(false);
  });

  it("tx with valid USD fx block does NOT need backfill", () => {
    expect(
      needsBackfill({
        fx: {
          originalCurrency: "USD",
          originalAmountCents: "135984",
          trmToAccountCurrency: 3676.92,
          trmSource: "email_implied",
        },
      }),
    ).toBe(false);
  });

  it("tx with malformed fx block needs backfill", () => {
    expect(needsBackfill({ fx: { originalCurrency: "EUR", amount: 100 } })).toBe(true);
  });

  it("running detection twice on a fixed tx returns false (idempotent)", () => {
    const rawData = {
      fx: {
        originalCurrency: "COP" as const,
        originalAmountCents: "50000",
        trmToAccountCurrency: null,
        trmSource: "1_to_1" as const,
      },
    };
    // First check: needs backfill (no fx).
    const broken = { kind: "purchase" };
    expect(needsBackfill(broken)).toBe(true);

    // After backfill (simulate write): check again.
    expect(needsBackfill(rawData)).toBe(false);

    // Running a third time: still false.
    expect(needsBackfill(rawData)).toBe(false);
  });

  it("all valid trmSource values pass", () => {
    const sources = [
      "1_to_1",
      "email_implied",
      "statement_frozen",
      "user_input",
      "unknown",
    ] as const;
    for (const trmSource of sources) {
      expect(
        needsBackfill({
          fx: {
            originalCurrency: "USD",
            originalAmountCents: "100",
            trmToAccountCurrency: null,
            trmSource,
          },
        }),
      ).toBe(false);
    }
  });
});
