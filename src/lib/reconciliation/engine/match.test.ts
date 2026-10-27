import { describe, expect, it } from "vitest";
import { jaccard, matchStatement, overlapCoefficient, tokenize } from "./match";
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

describe("overlapCoefficient", () => {
  it("is 1 when the smaller set is fully contained in the larger", () => {
    // The key property: asymmetric size does NOT penalize.
    expect(
      overlapCoefficient(
        new Set(["polar", "tonnoz"]),
        new Set(["compra", "polar", "tonnoz", "ser"]),
      ),
    ).toBe(1);
  });
  it("handles the real POLAR smoke-test case above the 0.5 threshold", () => {
    const bank = new Set(["compra", "intl", "polar", "tonnoz", "ser"]);
    const sms = new Set(["polar", "tonnoz", "servic"]);
    // 2 / min(5,3) = 0.67, where jaccard would give 2/6 = 0.33 (below 0.5).
    expect(overlapCoefficient(bank, sms)).toBeCloseTo(2 / 3);
  });
  it("is 0 when either side is empty", () => {
    expect(overlapCoefficient(new Set(), new Set(["a"]))).toBe(0);
    expect(overlapCoefficient(new Set(["a"]), new Set())).toBe(0);
    expect(overlapCoefficient(new Set(), new Set())).toBe(0);
  });
  it("is 0 for disjoint sets", () => {
    expect(overlapCoefficient(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
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
      // 10 pesos off: past the #1023 cent-rounding window, still a near-match.
      existingTxns: [existingTxn({ id: 1, occurredAt: date, amountCents: BigInt(-9_000) })],
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

  it("emits near_match for the real POLAR smoke-test case (asymmetric descriptions)", () => {
    // Actual descriptions captured on 2026-04-19: bank-feed is longer and
    // has prefix noise ("COMPRA INTL") — jaccard would score 2/6 = 0.33 and
    // reject. Overlap coefficient scores 2/3 = 0.67 and accepts, which is
    // the correct behavior for this real FX-rounding duplicate.
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(25_573_00),
          direction: "out",
          descriptionRaw: "COMPRA INTL POLAR TONNOZ SER",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 42,
          occurredAt: date,
          amountCents: BigInt(-25_448_00), // ← 125 pesos off
          descriptionRaw: "POLAR* TONNOZ-SERVIC",
          merchant: "POLAR* TONNOZ-SERVIC",
        }),
      ],
    });
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0].action).toBe("near_match");
    expect(plan.decisions[0].matchedTxnId).toBe(42);
    expect(plan.decisions[0].matchReason).toBe("near_match_fuzzy_amount");
    expect(plan.decisions[0].amountDiffCents).toBe("12500");
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

  it("does NOT emit near_match when the smaller side has fewer than 2 tokens (noise guard)", () => {
    // A 1-token SMS like `{pago}` would score overlap 1.0 against any
    // description containing "pago" — the guard rejects before that.
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(100_00),
          direction: "out",
          descriptionRaw: "PAGO QR SOLUCIONES RESTAURANTE ARGENTINO",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          amountCents: BigInt(-99_00),
          descriptionRaw: "PAGO", // 1 meaningful token — below guard
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

  it("respects nearMatch.descriptionSimilarityMin override (looser cutoff)", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(10_00),
          direction: "out",
          descriptionRaw: "ALPHA BETA GAMMA DELTA EPSILON",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          // 1,50 pesos off — outside the #1023 rounding window, so this test
          // keeps isolating the similarity cutoff.
          amountCents: BigInt(-8_50),
          descriptionRaw: "ALPHA ZULU OMEGA SIGMA LAMBDA", // 1/5 overlap = 0.2
        }),
      ],
      // default threshold 0.5 would reject — loosening to 0.15 accepts.
      config: { nearMatch: { descriptionSimilarityMin: 0.15 } },
    });
    expect(plan.decisions[0].action).toBe("near_match");
  });

  it("respects nearMatch.minTokensInSmallerSet override (loosening the noise guard)", () => {
    const plan = matchStatement({
      parsedRows: [
        parsedRow({
          occurredAt: date,
          amountCents: BigInt(100_00),
          direction: "out",
          descriptionRaw: "PAGO QR SOLUCIONES RESTAURANTE",
        }),
      ],
      existingTxns: [
        existingTxn({
          id: 1,
          occurredAt: date,
          // 10 pesos off — outside the #1023 rounding window, so the guard
          // below is the only thing standing between the pair and a match.
          amountCents: BigInt(-90_00),
          descriptionRaw: "PAGO", // 1-token SMS, default guard rejects
        }),
      ],
      // Loosen the guard to 1 token — now the 1.0 overlap is accepted.
      config: { nearMatch: { minTokensInSmallerSet: 1 } },
    });
    expect(plan.decisions[0].action).toBe("near_match");
  });
});

// #1023 — the SMS rounds to the peso, the bank prints the exact figure. Up to
// one currency unit (100 cents) on the same-or-next day is the same movement,
// so the engine must emit `match` and let commit link it. Emitting
// `near_match` inserted the statement row and duplicated the movement.
describe("matchStatement — cent-rounding promotion (#1023)", () => {
  const date = new Date("2026-10-26T05:00:00Z");

  // The prod shape from the issue: `Pago TC *7291` on savings, SMS-captured
  // and statement rows 70 cents apart.
  function pagoRow(amountCents: bigint): ParsedStatementRow {
    return parsedRow({
      occurredAt: date,
      amountCents,
      direction: "out",
      descriptionRaw: "PAGO TC *7291",
    });
  }
  function pagoTxn(id: number, amountCents: bigint, occurredAt = date): ExistingTxnForMatch {
    return existingTxn({ id, occurredAt, amountCents, descriptionRaw: "PAGO TC *7291" });
  }

  it("promotes a same-day cent-rounding difference to match / amount_rounding", () => {
    const plan = matchStatement({
      parsedRows: [pagoRow(BigInt(1_459_70))],
      existingTxns: [pagoTxn(1459, BigInt(-1_459_00))],
    });

    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0].action).toBe("match");
    expect(plan.decisions[0].matchReason).toBe("amount_rounding");
    expect(plan.decisions[0].matchedTxnId).toBe(1459);
    expect(plan.summary).toEqual({
      matched: 1,
      newInserts: 0,
      nearMatches: 0,
      flaggedExisting: 0,
    });
    // Consumed: nothing is left behind for a post-Apply manual merge.
    expect(plan.flaggedExisting).toEqual([]);
  });

  it("promotes exactly one currency unit (100 cents) of difference", () => {
    const plan = matchStatement({
      parsedRows: [pagoRow(BigInt(1_101_00))],
      existingTxns: [pagoTxn(1100, BigInt(-1_100_00))],
    });
    expect(plan.decisions[0].action).toBe("match");
    expect(plan.decisions[0].matchReason).toBe("amount_rounding");
  });

  it("keeps near_match one cent past the unit (a rounding rule, not a bulk merger)", () => {
    const plan = matchStatement({
      parsedRows: [pagoRow(BigInt(1_101_01))],
      existingTxns: [pagoTxn(1100, BigInt(-1_100_00))],
    });
    expect(plan.decisions[0].action).toBe("near_match");
    expect(plan.decisions[0].matchReason).toBe("near_match_fuzzy_amount");
    expect(plan.summary.matched).toBe(0);
    expect(plan.summary.nearMatches).toBe(1);
  });

  it("keeps near_match when the rounding-sized pair is more than a day apart", () => {
    const plan = matchStatement({
      parsedRows: [pagoRow(BigInt(1_459_70))],
      existingTxns: [pagoTxn(1459, BigInt(-1_459_00), new Date(date.getTime() - 2 * DAY_MS))],
    });
    expect(plan.decisions[0].action).toBe("near_match");
    expect(plan.decisions[0].matchReason).toBe("near_match_fuzzy_amount");
  });

  it("promotes a pair exactly a day apart and closes the window past the rounded day", () => {
    const HOUR = 3_600_000;
    const at = (hours: number) => new Date(date.getTime() + hours * HOUR);
    const plan = (hours: number) =>
      matchStatement({
        parsedRows: [pagoRow(BigInt(1_459_70))],
        existingTxns: [pagoTxn(1459, BigInt(-1_459_00), at(hours))],
      });

    expect(plan(24).decisions[0]).toMatchObject({
      action: "match",
      matchReason: "amount_rounding",
      dateDiffDays: 1,
    });
    // Every day figure in this engine is Math.round(delta / day) — including
    // the near-match `dateDiffDays` the repair script reads — so the window
    // closes past 36h, not at exactly 24h. Pinned so the leniency is a
    // decision rather than an accident.
    expect(plan(34).decisions[0].action).toBe("match");
    expect(plan(36).decisions[0]).toMatchObject({
      action: "near_match",
      matchReason: "near_match_fuzzy_amount",
    });
  });

  it("never lets two statement rows consume the same rounding candidate", () => {
    const plan = matchStatement({
      parsedRows: [pagoRow(BigInt(1_459_70)), pagoRow(BigInt(1_459_50))],
      existingTxns: [pagoTxn(7, BigInt(-1_459_00))],
    });
    expect(plan.decisions.map((d) => d.action)).toEqual(["match", "insert_new"]);
    expect(plan.decisions[0].matchedTxnId).toBe(7);
    expect(plan.decisions[1].matchedTxnId).toBeNull();
  });

  it("prefers the rounding candidate when a farther-off candidate scores the same", () => {
    // Same day, same description, so both candidates score 100. The order in
    // the input array must not decide which one is linked: the cent-rounding
    // pair is the movement, the 20-peso-apart one is noise.
    const plan = matchStatement({
      parsedRows: [pagoRow(BigInt(1_459_70))],
      existingTxns: [pagoTxn(2, BigInt(-1_439_70)), pagoTxn(1459, BigInt(-1_459_00))],
    });
    expect(plan.decisions[0].action).toBe("match");
    expect(plan.decisions[0].matchReason).toBe("amount_rounding");
    expect(plan.decisions[0].matchedTxnId).toBe(1459);
    expect(plan.flaggedExisting).toEqual([{ txnId: 2, reason: "no_statement_match" }]);
  });
});
