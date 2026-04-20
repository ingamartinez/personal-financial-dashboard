import { describe, expect, it } from "vitest";
import { jaccard, matchStatement, tokenize } from "./match";
import type { ExistingTxnForMatch } from "./types";
import type { ParsedStatementRow } from "../parsers/types";

const DAY_MS = 86_400_000;

function parsedRow(
  overrides: Partial<ParsedStatementRow> & Pick<ParsedStatementRow, "occurredAt">,
): ParsedStatementRow {
  return {
    amountCents: BigInt(10_000),
    currency: "COP",
    direction: "out",
    descriptionRaw: "SOME CHARGE",
    rawData: {},
    isMetadata: false,
    ...overrides,
  };
}

function existingTxn(
  overrides: Partial<ExistingTxnForMatch> & Pick<ExistingTxnForMatch, "id" | "occurredAt">,
): ExistingTxnForMatch {
  return {
    amountCents: BigInt(-10_000),
    currency: "COP",
    descriptionRaw: "SOME CHARGE",
    merchant: null,
    channel: "bank",
    isAdjustment: false,
    reconciliationStatus: "unreconciled",
    ...overrides,
  };
}

describe("tokenize", () => {
  it("lowercases, strips accents + punct, drops tokens <3 chars", () => {
    expect(tokenize("DLO*DIDI FOOD — CO.PAYIN")).toEqual(new Set(["dlo", "didi", "food", "payin"]));
  });
  it("handles empty strings", () => {
    expect(tokenize("")).toEqual(new Set());
  });
});

describe("jaccard", () => {
  it("is 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("is 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("returns intersect / union for partial overlap", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(2 / 4);
  });
  it("returns 0 for two empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe("matchStatement — happy paths", () => {
  const date = new Date("2026-04-10T05:00:00Z");

  it("exact match when amount + date + currency + direction all line up", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, descriptionRaw: "DLO DIDI FOOD" })],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, descriptionRaw: "DLO DIDI FOOD" })],
    });
    expect(plan.decisions).toEqual([
      {
        statementRowIndex: 0,
        action: "match",
        matchedTxnId: 1,
        matchScore: 100,
        matchReason: "amount_date_fuzzy_merchant",
      },
    ]);
    expect(plan.summary).toEqual({ matched: 1, newInserts: 0, nearMatches: 0, flaggedExisting: 0 });
    expect(plan.flaggedExisting).toEqual([]);
  });

  it("near match (2 days apart) still accepted with reduced score", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date })],
      existingTxns: [existingTxn({ id: 1, occurredAt: new Date(date.getTime() - 2 * DAY_MS) })],
    });
    expect(plan.decisions[0].action).toBe("match");
    expect(plan.decisions[0].matchScore).toBeLessThan(100);
  });

  it("out of tolerance (5 days apart) → insert_new", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date })],
      existingTxns: [existingTxn({ id: 1, occurredAt: new Date(date.getTime() - 5 * DAY_MS) })],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
    expect(plan.decisions[0].matchedTxnId).toBeNull();
  });
});

describe("matchStatement — currency / amount / direction rules", () => {
  const date = new Date("2026-04-10T05:00:00Z");

  it("different currency never matches", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, currency: "USD" })],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, currency: "COP" })],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
  });

  it("different magnitude never reaches exact match (can fall through to near_match)", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, amountCents: BigInt(10_000) })],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, amountCents: BigInt(-9_900) })],
    });
    // Exact match is rejected on amount mismatch. The near-match fallback
    // may or may not pick it up depending on thresholds; we only care that
    // it's NOT classified as an exact match.
    expect(plan.decisions[0].action).not.toBe("match");
  });

  it("very different magnitude (outside both exact and near thresholds) becomes insert_new", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, amountCents: BigInt(10_000_00) })],
      // $9000 off on a $10k txn — way outside 1% ($100) and the $500 floor.
      existingTxns: [existingTxn({ id: 1, occurredAt: date, amountCents: BigInt(-1_000_00) })],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
  });

  it("direction mismatch (same magnitude, opposite sign) never matches", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, direction: "out" })],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, amountCents: BigInt(10_000) })],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
  });

  it("in-direction parsed row matches positive-signed existing", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, direction: "in" })],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, amountCents: BigInt(10_000) })],
    });
    expect(plan.decisions[0].action).toBe("match");
  });
});

describe("matchStatement — candidate selection", () => {
  const date = new Date("2026-04-10T05:00:00Z");

  it("multiple candidates with same amount+date → picks highest merchant similarity", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, descriptionRaw: "RAPPI COLOMBIA" })],
      existingTxns: [
        existingTxn({ id: 1, occurredAt: date, descriptionRaw: "UNRELATED MERCHANT" }),
        existingTxn({ id: 2, occurredAt: date, descriptionRaw: "RAPPI COLOMBIA FOOD" }),
      ],
    });
    expect(plan.decisions[0].matchedTxnId).toBe(2);
  });

  it("ties on merchant score → picks earlier (by date proximity / first in list)", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date, descriptionRaw: "NEUTRAL DESC" })],
      existingTxns: [
        existingTxn({ id: 1, occurredAt: date, descriptionRaw: "OTHER" }),
        existingTxn({ id: 2, occurredAt: date, descriptionRaw: "OTHER" }),
      ],
    });
    expect(plan.decisions[0].matchedTxnId).toBe(1);
  });

  it("two parsed rows compete for same existing — first one wins; second one inserts new", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({ occurredAt: date, descriptionRaw: "first" }),
        parsedRow({ occurredAt: date, descriptionRaw: "second" }),
      ],
      existingTxns: [existingTxn({ id: 1, occurredAt: date })],
    });
    expect(plan.decisions[0].action).toBe("match");
    expect(plan.decisions[0].matchedTxnId).toBe(1);
    expect(plan.decisions[1].action).toBe("insert_new");
  });
});

describe("matchStatement — exclusion rules", () => {
  const date = new Date("2026-04-10T05:00:00Z");

  it("channel='manual' existing is neither matched nor flagged", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date })],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, channel: "manual" })],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
    expect(plan.flaggedExisting).toEqual([]);
  });

  it("is_adjustment=true existing is neither matched nor flagged", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date })],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, isAdjustment: true })],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
    expect(plan.flaggedExisting).toEqual([]);
  });

  it("already 'matched' existing doesn't get re-flagged", () => {
    const plan = matchStatement({
      parsedRows: [],
      existingTxns: [existingTxn({ id: 1, occurredAt: date, reconciliationStatus: "matched" })],
    });
    expect(plan.flaggedExisting).toEqual([]);
  });

  it("'imported_from_statement' existing doesn't get re-flagged", () => {
    const plan = matchStatement({
      parsedRows: [],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          reconciliationStatus: "imported_from_statement",
        }),
      ],
    });
    expect(plan.flaggedExisting).toEqual([]);
  });

  it("'unreconciled' bank-channel existing NOT matched → flagged", () => {
    const plan = matchStatement({
      parsedRows: [],
      existingTxns: [existingTxn({ id: 1, occurredAt: date })],
    });
    expect(plan.flaggedExisting).toEqual([{ txnId: 1, reason: "no_statement_match" }]);
    expect(plan.summary.flaggedExisting).toBe(1);
  });
});

describe("matchStatement — invariants", () => {
  const date = new Date("2026-04-10T05:00:00Z");

  it("is deterministic: same input → identical output (twice)", () => {
    const input = {
      parsedRows: [
        parsedRow({ occurredAt: date, descriptionRaw: "a" }),
        parsedRow({ occurredAt: date, descriptionRaw: "b" }),
      ],
      existingTxns: [
        existingTxn({ id: 1, occurredAt: date, descriptionRaw: "a" }),
        existingTxn({ id: 2, occurredAt: date, descriptionRaw: "b" }),
      ],
    };
    const a = matchStatement(input);
    const b = matchStatement(input);
    expect(a).toEqual(b);
  });

  it("summary counts agree with decisions + flaggedExisting arrays", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({ occurredAt: date, descriptionRaw: "matched" }),
        parsedRow({ occurredAt: date, descriptionRaw: "new" }),
      ],
      existingTxns: [
        existingTxn({ id: 1, occurredAt: date, descriptionRaw: "matched" }),
        existingTxn({ id: 2, occurredAt: date, descriptionRaw: "unmatched existing" }),
      ],
    });
    expect(plan.summary.matched).toBe(plan.decisions.filter((d) => d.action === "match").length);
    expect(plan.summary.newInserts).toBe(
      plan.decisions.filter((d) => d.action === "insert_new").length,
    );
    expect(plan.summary.flaggedExisting).toBe(plan.flaggedExisting.length);
  });

  it("dateToleranceDays config is honored", () => {
    const plan = matchStatement({
      parsedRows: [parsedRow({ occurredAt: date })],
      existingTxns: [existingTxn({ id: 1, occurredAt: new Date(date.getTime() - 5 * DAY_MS) })],
      config: { dateToleranceDays: 7 },
    });
    expect(plan.decisions[0].action).toBe("match");
  });
});

describe("matchStatement — near-match fallback", () => {
  const date = new Date("2026-04-14T05:00:00Z");

  it("emits near_match when amount is 1 peso off but date + description align (FX rounding case)", () => {
    // Real shape from smoke-test today: bank statement has "COMPRA INTL POLAR
    // TONNOZ SER" and the SMS-captured findash row has "POLAR TONNOZ SERVIC"
    // — decent token overlap + 1-peso amount drift from FX rounding.
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(1_320_565_00),
          direction: "out",
          descriptionRaw: "COMPRA INTL POLAR TONNOZ SERVIC",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 42,
          occurredAt: date,
          amountCents: BigInt(-1_320_564_00), // ← 1 peso off
          descriptionRaw: "POLAR TONNOZ SERVIC",
        }),
      ],
    });
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0].action).toBe("near_match");
    expect(plan.decisions[0].matchedTxnId).toBe(42);
    expect(plan.decisions[0].matchReason).toBe("near_match_fuzzy_amount");
    expect(plan.decisions[0].amountDiffCents).toBe("100");
    expect(plan.decisions[0].dateDiffDays).toBe(0);
    expect(plan.summary.nearMatches).toBe(1);
    expect(plan.summary.newInserts).toBe(0);
    // Candidate is NOT consumed — it flows to flaggedExisting so the user
    // can resolve via merge-into post-Apply.
    expect(plan.flaggedExisting).toEqual([{ txnId: 42, reason: "no_statement_match" }]);
  });

  it("does NOT emit near_match when amount differs by more than 1% + absolute floor", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(100_000_00), // $100k, 1% = $1k, floor $500
          direction: "out",
          descriptionRaw: "SHARED DESCRIPTION",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          amountCents: BigInt(-90_000_00), // $10k off → well above $1k threshold
          descriptionRaw: "SHARED DESCRIPTION",
        }),
      ],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
    expect(plan.summary.nearMatches).toBe(0);
  });

  it("does NOT emit near_match for opposite signs (debit vs credit)", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(1_320_564_00),
          direction: "in", // credit in the statement
          descriptionRaw: "ABONO",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          amountCents: BigInt(-1_320_565_00), // debit in findash
          descriptionRaw: "ABONO",
        }),
      ],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
  });

  it("does NOT emit near_match when description overlap is below threshold", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(100_00),
          direction: "out",
          descriptionRaw: "ONE TWO THREE FOUR",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          amountCents: BigInt(-99_00), // $1 off, within threshold
          descriptionRaw: "ALPHA BETA GAMMA DELTA", // zero overlap
        }),
      ],
    });
    expect(plan.decisions[0].action).toBe("insert_new");
  });

  it("prefers exact match over near-match when both candidates are available", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(1_320_565_00),
          direction: "out",
          descriptionRaw: "PAGO TC",
        }),
      ],
      existingTxns: [
        // near-match candidate (amount differs by 1 peso)
        existingTxn({
          id: 1,
          occurredAt: date,
          amountCents: BigInt(-1_320_564_00),
          descriptionRaw: "PAGO TC",
        }),
        // exact match candidate
        existingTxn({
          id: 2,
          occurredAt: date,
          amountCents: BigInt(-1_320_565_00),
          descriptionRaw: "PAGO TC",
        }),
      ],
    });
    expect(plan.decisions[0].action).toBe("match");
    expect(plan.decisions[0].matchedTxnId).toBe(2);
    // The near-match candidate stays unreconciled → flagged.
    expect(plan.flaggedExisting).toEqual([{ txnId: 1, reason: "no_statement_match" }]);
  });

  it("respects nearMatch config overrides (tighter similarity cutoff)", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(10_00),
          direction: "out",
          descriptionRaw: "ONE TWO THREE FOUR",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          amountCents: BigInt(-9_50),
          descriptionRaw: "ONE TWO FIVE SIX", // 2/6 = 0.33 jaccard
        }),
      ],
      // default threshold 0.5 would reject this — tightening to 0.2 accepts.
      config: { nearMatch: { descriptionSimilarityMin: 0.2 } },
    });
    expect(plan.decisions[0].action).toBe("near_match");
  });
});
