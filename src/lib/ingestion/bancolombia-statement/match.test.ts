import { describe, expect, it } from "vitest";

import {
  isBankInterestRow,
  matchStatementAgainstLedger,
  merchantSimilarity,
  type TxRowForMatch,
} from "./match";
import type { ParsedStatement, StatementRow } from "./types";

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function buildStatement(rows: StatementRow[]): ParsedStatement {
  return {
    account: { last4: "9999", currency: "COP" },
    period: {
      startDate: utcDate(2026, 2, 28),
      endDate: utcDate(2026, 3, 30),
      dueDate: utcDate(2026, 4, 16),
    },
    summary: {
      previousBalanceCents: BigInt(0),
      purchasesCents: BigInt(0),
      interestCorrientesCents: BigInt(0),
      paymentsCents: BigInt(0),
      minPaymentCents: BigInt(0),
      totalPaymentCents: BigInt(0),
      currentBalanceCents: BigInt(0),
    },
    currentRates: { oneMonth: 0, months2to36: 19110, advances: 19110 },
    rows,
  };
}

function buildRow(
  partial: Partial<StatementRow> & Pick<StatementRow, "amountCents" | "merchant" | "occurredAt">,
): StatementRow {
  // Use `'key' in partial` so explicit null/zero values aren't clobbered by defaults.
  return {
    kind: "kind" in partial ? (partial.kind as StatementRow["kind"]) : "during-period",
    authorizationNumber:
      "authorizationNumber" in partial ? (partial.authorizationNumber as string | null) : "000001",
    merchant: partial.merchant,
    occurredAt: partial.occurredAt,
    amountCents: partial.amountCents,
    installments:
      "installments" in partial
        ? (partial.installments as StatementRow["installments"])
        : { paid: 1, total: 1 },
    installmentValueCents:
      "installmentValueCents" in partial
        ? (partial.installmentValueCents as bigint | null)
        : partial.amountCents,
    rateEmX10k: "rateEmX10k" in partial ? (partial.rateEmX10k as number | null) : 0,
    saldoPendingCents:
      "saldoPendingCents" in partial ? (partial.saldoPendingCents as bigint) : BigInt(0),
  };
}

// Builds a ledger tx row by flipping the caller-provided "statement amount"
// into ledger-sign convention (TC expense = negative). Tests stay readable:
// pass the positive amount that would appear on the extracto and we persist
// the signed version the matcher expects.
function buildTx(
  partial: Partial<TxRowForMatch> & Pick<TxRowForMatch, "id" | "amountCents" | "occurredAt">,
): TxRowForMatch {
  return {
    id: partial.id,
    occurredAt: partial.occurredAt,
    amountCents: -partial.amountCents,
    merchant: partial.merchant ?? null,
    descriptionRaw: partial.descriptionRaw ?? "",
    installmentsTotal: partial.installmentsTotal ?? 1,
    installmentRateEmX10k: partial.installmentRateEmX10k ?? null,
    externalId: partial.externalId ?? null,
  };
}

// -----------------------------------------------------------------------------
// merchantSimilarity
// -----------------------------------------------------------------------------

describe("merchantSimilarity", () => {
  it("returns 1 for identical normalized strings", () => {
    expect(merchantSimilarity("DLO*DIDI", "DLO*DIDI")).toBe(1);
  });

  it("returns a high ratio for partial token overlap", () => {
    expect(merchantSimilarity("MERCADOPAGO COLOMBIA L", "MERCADOPAGO COLOMBIA")).toBeGreaterThan(
      0.5,
    );
  });

  it("returns 0 for completely unrelated merchants", () => {
    expect(merchantSimilarity("AIRBNB", "DLO DIDI")).toBe(0);
  });

  it("is case-insensitive and strips punctuation", () => {
    expect(merchantSimilarity("dlo*didi", "DLO DIDI")).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// isBankInterestRow
// -----------------------------------------------------------------------------

describe("isBankInterestRow", () => {
  it("detects the synthetic INTERESES CORRIENTES row", () => {
    const row = buildRow({
      merchant: "INTERESES CORRIENTES",
      occurredAt: utcDate(2026, 3, 30),
      amountCents: BigInt(7991836),
    });
    row.authorizationNumber = null;
    expect(isBankInterestRow(row)).toBe(true);
  });

  it("does NOT match a purchase whose merchant happens to contain 'INTERES'", () => {
    const row = buildRow({
      merchant: "INTERESES BANCO",
      occurredAt: utcDate(2026, 3, 10),
      amountCents: BigInt(10000),
    });
    expect(isBankInterestRow(row)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// matchStatementAgainstLedger
// -----------------------------------------------------------------------------

describe("matchStatementAgainstLedger — exact matches", () => {
  it("matches rows 1:1 when amount + date align", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(1895200),
        occurredAt: utcDate(2026, 3, 26),
        merchant: "DLO*DIDI",
      }),
      buildRow({
        amountCents: BigInt(1320500),
        occurredAt: utcDate(2026, 3, 26),
        merchant: "DLO*DIDI",
      }),
    ]);
    const txs = [
      buildTx({
        id: 1,
        amountCents: BigInt(1895200),
        occurredAt: utcDate(2026, 3, 26),
        merchant: "DLO*DIDI",
      }),
      buildTx({
        id: 2,
        amountCents: BigInt(1320500),
        occurredAt: utcDate(2026, 3, 26),
        merchant: "DLO*DIDI",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched.map((m) => m.txId).sort()).toEqual([1, 2]);
    expect(result.missingInLedger).toHaveLength(0);
    expect(result.unmatchedInLedger).toHaveLength(0);
  });

  it("tolerates ±1 day when matching dates", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 15),
        merchant: "AIRBNB",
      }),
    ]);
    const txs = [
      buildTx({
        id: 10,
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 16),
        merchant: "AIRBNB",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].txId).toBe(10);
  });

  it("does NOT match when date delta exceeds the tolerance", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 15),
        merchant: "AIRBNB",
      }),
    ]);
    const txs = [
      buildTx({
        id: 11,
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 20),
        merchant: "AIRBNB",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched).toHaveLength(0);
    expect(result.missingInLedger).toHaveLength(1);
    expect(result.unmatchedInLedger).toHaveLength(1);
  });
});

describe("matchStatementAgainstLedger — tie-breakers", () => {
  it("picks the candidate with the highest merchant similarity when two txs match same amount+date", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(1000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "MIYAGI CARTAGENA",
      }),
    ]);
    const txs = [
      buildTx({
        id: 100,
        amountCents: BigInt(1000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "RANDOM SHOP",
      }),
      buildTx({
        id: 101,
        amountCents: BigInt(1000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "MIYAGI CARTAGENA",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched[0].txId).toBe(101);
    expect(result.unmatchedInLedger.map((t) => t.id)).toEqual([100]);
  });

  it("prefers the smaller date delta over merchant similarity", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(500000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "FOOBAR",
      }),
    ]);
    const txs = [
      buildTx({
        id: 200,
        amountCents: BigInt(500000),
        occurredAt: utcDate(2026, 3, 11),
        merchant: "FOOBAR",
      }),
      buildTx({
        id: 201,
        amountCents: BigInt(500000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "DIFFERENT",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched[0].txId).toBe(201);
  });
});

describe("matchStatementAgainstLedger — willChange detection", () => {
  it("flags willChange when installments_total differs", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "AIRBNB",
        installments: { paid: 1, total: 6 },
        rateEmX10k: 19110,
      }),
    ]);
    const txs = [
      buildTx({
        id: 300,
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "AIRBNB",
        installmentsTotal: 1,
        installmentRateEmX10k: null,
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched[0].willChange).toBe(true);
    expect(result.matched[0].diff.installmentsTotalAfter).toBe(6);
    expect(result.matched[0].diff.rateEmX10kAfter).toBe(19110);
  });

  it("does NOT flag willChange when everything already matches", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "AIRBNB",
        installments: { paid: 1, total: 6 },
        rateEmX10k: 19110,
      }),
    ]);
    const txs = [
      buildTx({
        id: 301,
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "AIRBNB",
        installmentsTotal: 6,
        installmentRateEmX10k: 19110,
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched[0].willChange).toBe(false);
  });

  it("does NOT overwrite an existing rate with null when the statement doesn't report one", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "AIRBNB",
        installments: null,
        rateEmX10k: null,
      }),
    ]);
    const txs = [
      buildTx({
        id: 302,
        amountCents: BigInt(5000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "AIRBNB",
        installmentsTotal: 1,
        installmentRateEmX10k: 19110,
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched[0].willChange).toBe(false);
  });
});

describe("matchStatementAgainstLedger — skip bank interest", () => {
  it("skips the INTERESES CORRIENTES row entirely", () => {
    const interestRow = buildRow({
      amountCents: BigInt(7991836),
      occurredAt: utcDate(2026, 3, 30),
      merchant: "INTERESES CORRIENTES",
      installments: null,
      rateEmX10k: null,
    });
    interestRow.authorizationNumber = null;

    const stmt = buildStatement([
      interestRow,
      buildRow({
        amountCents: BigInt(1000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "SHOP",
      }),
    ]);
    const txs = [
      buildTx({
        id: 400,
        amountCents: BigInt(1000000),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "SHOP",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].txId).toBe(400);
    // Bank-interest row never appears in missingInLedger either.
    expect(result.missingInLedger).toHaveLength(0);
  });
});

// #763 — credit-card-specific tolerance override
describe("matchStatementAgainstLedger — credit card date tolerance override", () => {
  it("matches when delta is 2 days and dateToleranceDays=3 is passed", () => {
    // Represents: SMS captured tx at authorization time (Apr 23),
    // statement records value-date 2 days later (Apr 25). Default ±1 would
    // miss it; explicit ±3 for credit cards must hit it.
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(2900000000),
        occurredAt: utcDate(2026, 4, 25),
        merchant: "COMPRA DE CARTERA Y/O DESEM",
      }),
    ]);
    const txs = [
      buildTx({
        id: 1931,
        amountCents: BigInt(2900000000),
        occurredAt: utcDate(2026, 4, 23),
        merchant: "CARTERA",
      }),
    ];
    // Without override: delta=2 > default 1 → no match
    const withoutOverride = matchStatementAgainstLedger(stmt, txs);
    expect(withoutOverride.matched).toHaveLength(0);
    expect(withoutOverride.missingInLedger).toHaveLength(1);

    // With credit-card override: delta=2 ≤ 3 → match
    const withOverride = matchStatementAgainstLedger(stmt, txs, { dateToleranceDays: 3 });
    expect(withOverride.matched).toHaveLength(1);
    expect(withOverride.matched[0].txId).toBe(1931);
    expect(withOverride.missingInLedger).toHaveLength(0);
  });

  it("still respects the wider tolerance boundary: delta=4 is NOT matched at dateToleranceDays=3", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(500000),
        occurredAt: utcDate(2026, 4, 10),
        merchant: "TIENDA",
      }),
    ]);
    const txs = [
      buildTx({
        id: 42,
        amountCents: BigInt(500000),
        occurredAt: utcDate(2026, 4, 6),
        merchant: "TIENDA",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs, { dateToleranceDays: 3 });
    expect(result.matched).toHaveLength(0);
    expect(result.missingInLedger).toHaveLength(1);
  });
});

describe("matchStatementAgainstLedger — missing and unmatched", () => {
  it("surfaces statement rows absent from the ledger", () => {
    const stmt = buildStatement([
      buildRow({
        amountCents: BigInt(200000),
        occurredAt: utcDate(2026, 3, 12),
        merchant: "NEW SHOP",
      }),
    ]);
    const result = matchStatementAgainstLedger(stmt, []);
    expect(result.missingInLedger).toHaveLength(1);
    expect(result.missingInLedger[0].merchant).toBe("NEW SHOP");
  });

  it("surfaces ledger txs absent from the statement", () => {
    const stmt = buildStatement([]);
    const result = matchStatementAgainstLedger(stmt, [
      buildTx({
        id: 500,
        amountCents: BigInt(100),
        occurredAt: utcDate(2026, 3, 5),
        merchant: "GHOST",
      }),
    ]);
    expect(result.unmatchedInLedger).toHaveLength(1);
    expect(result.unmatchedInLedger[0].id).toBe(500);
  });

  it("never reuses a tx: once matched it cannot anchor another statement row", () => {
    const stmt = buildStatement([
      buildRow({ amountCents: BigInt(100), occurredAt: utcDate(2026, 3, 10), merchant: "A" }),
      buildRow({ amountCents: BigInt(100), occurredAt: utcDate(2026, 3, 10), merchant: "B" }),
    ]);
    const txs = [
      buildTx({
        id: 600,
        amountCents: BigInt(100),
        occurredAt: utcDate(2026, 3, 10),
        merchant: "A",
      }),
    ];
    const result = matchStatementAgainstLedger(stmt, txs);
    expect(result.matched).toHaveLength(1);
    expect(result.missingInLedger).toHaveLength(1);
    expect(result.missingInLedger[0].merchant).toBe("B");
  });

  // Refinanciación pairs (AMPLIACION DE PLAZO + ABONO AMPLIACION) both carry
  // authorizationNumber="000000" with INVERSE amounts. The matcher must not
  // cross-match them against each other — they have different amounts in ledger
  // sign (+4M and -4M) so the candidate filter naturally prevents a cross-match.
  // Both must reach missingInLedger so consolidate.ts can insert them.
  it("refinanciación pair with auth=000000 both reach missingInLedger (not matched to each other)", () => {
    const REFINANCIACION_CENTS = BigInt(409952337);
    const stmt = buildStatement([
      // ABONO AMPLIACION DE PLAZO: credita el saldo (negative in extracto sign)
      buildRow({
        amountCents: -REFINANCIACION_CENTS,
        occurredAt: utcDate(2026, 3, 24),
        merchant: "ABONO AMPLIACION DE PLA",
        authorizationNumber: "000000",
        installments: null,
        rateEmX10k: null,
      }),
      // AMPLIACION DE PLAZO: carga el nuevo plazo (positive in extracto sign)
      buildRow({
        amountCents: REFINANCIACION_CENTS,
        occurredAt: utcDate(2026, 3, 24),
        merchant: "AMPLIACION DE PLAZO",
        authorizationNumber: "000000",
        installments: { paid: 1, total: 60 },
        rateEmX10k: 19110,
      }),
    ]);
    // No existing txs — both rows must surface as missing.
    const result = matchStatementAgainstLedger(stmt, []);
    expect(result.matched).toHaveLength(0);
    expect(result.missingInLedger).toHaveLength(2);
    const merchants = result.missingInLedger.map((r) => r.merchant).sort();
    expect(merchants).toEqual(["ABONO AMPLIACION DE PLA", "AMPLIACION DE PLAZO"].sort());
  });
});
