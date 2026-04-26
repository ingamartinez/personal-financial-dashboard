// Tests for the ARQ statement balance reconciliation invariant (#515).
//
// All tests are pure (no DB). The integration tests for runStatementImport
// live in run-statement-import.test.ts.

import { describe, expect, it } from "vitest";

import { buildChainCheck, reconcileStatement } from "./balance";
import type { ParsedStatementTx } from "./type-handlers";
import type { RawStatement, RawTxLine } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal RawTxLine for a credit. */
function credit(amountCents: bigint, description = "credit"): RawTxLine {
  return {
    date: new Date(Date.UTC(2026, 0, 10)),
    type: "Compra USDc",
    amountCents,
    equivalentCurrency: "USD",
    equivalentAmountCents: amountCents,
    description,
  };
}

/** Build a minimal RawTxLine for a debit. */
function debit(amountCents: bigint, description = "debit"): RawTxLine {
  return {
    date: new Date(Date.UTC(2026, 0, 15)),
    type: "Pago con tarjeta",
    amountCents: -amountCents, // negative = debit
    equivalentCurrency: "COP",
    equivalentAmountCents: -amountCents * BigInt(3700),
    description,
  };
}

/**
 * Build a synthetic ParsedStatementTx for credit amounts.
 * For reconciliation tests we only need amountUsdc.
 */
function parsedCredit(amountCents: bigint): ParsedStatementTx {
  return {
    kind: "transfer_received",
    occurredAt: new Date(Date.UTC(2026, 0, 10)),
    amountUsdc: amountCents,
    externalIdPrefix: "arq-stmt",
    externalId: "aabbcc001122334455667788",
    originalCurrency: "USD",
    originalAmount: amountCents,
    counterparty: "TEST",
    trmCopPerUsdc: null,
  };
}

function parsedDebit(amountCents: bigint): ParsedStatementTx {
  return {
    kind: "purchase",
    occurredAt: new Date(Date.UTC(2026, 0, 15)),
    amountUsdc: -amountCents, // negative
    externalIdPrefix: "arq-stmt",
    externalId: "aabbcc112233445566778899",
    merchant: "TIENDA",
    originalCurrency: "COP",
    originalAmount: amountCents * BigInt(3700),
    trmCopPerUsdc: 3700,
  };
}

function parsedSkip(raw: RawTxLine): ParsedStatementTx {
  return { kind: "skip", reason: "test skip", raw };
}

/**
 * Build a complete RawStatement for January 2026 with the given summary values.
 * The transactions list is used by the parser but we pass parsed txs directly
 * to reconcileStatement in tests.
 */
function makeStatement(summary: {
  balanceStartCents: bigint;
  totalCreditsCents: bigint;
  totalDebitsCents: bigint;
  balanceEndCents: bigint;
}): RawStatement {
  return {
    header: {
      accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
      accountNumber: "211215197073",
      routingNumber: "101019644",
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      periodEnd: new Date(Date.UTC(2026, 0, 31)),
      durationDays: 31,
      summary,
    },
    transactions: [],
  };
}

// ---------------------------------------------------------------------------
// Real-world January 2026 numbers (from issue #514 fixtures — redacted names)
//   balanceStart = $262.96 = 26296 cents
//   totalCredits = $2060.00 = 206000 cents
//   totalDebits  = $1594.01 = 159401 cents
//   balanceEnd   = $728.95 = 72895 cents
//   check: 26296 + 206000 − 159401 = 72895 ✓
// ---------------------------------------------------------------------------

const JAN_2026_SUMMARY = {
  balanceStartCents: BigInt(26296),
  totalCreditsCents: BigInt(206000),
  totalDebitsCents: BigInt(159401),
  balanceEndCents: BigInt(72895),
};

const JAN_2026 = makeStatement(JAN_2026_SUMMARY);

// A minimal set of parsed txs that exactly matches the Jan 2026 summary.
// Credits: 206000. Debits: 159401.
const JAN_2026_TXS: ParsedStatementTx[] = [
  parsedCredit(BigInt(206000)),
  parsedDebit(BigInt(159401)),
];

// ---------------------------------------------------------------------------
// reconcileStatement — happy path
// ---------------------------------------------------------------------------

describe("reconcileStatement — happy path", () => {
  it("returns ok=true when all sums match", () => {
    const result = reconcileStatement(JAN_2026, JAN_2026_TXS);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("calculates parsedCreditsCents correctly", () => {
    const result = reconcileStatement(JAN_2026, JAN_2026_TXS);
    expect(result.parsedCreditsCents).toBe(BigInt(206000));
  });

  it("calculates parsedDebitsCents correctly (absolute value)", () => {
    const result = reconcileStatement(JAN_2026, JAN_2026_TXS);
    expect(result.parsedDebitsCents).toBe(BigInt(159401));
  });

  it("calculates parsedSumCents = credits − debits", () => {
    const result = reconcileStatement(JAN_2026, JAN_2026_TXS);
    expect(result.parsedSumCents).toBe(BigInt(206000) - BigInt(159401));
  });

  it("diffCents = 0 on a perfect match", () => {
    const result = reconcileStatement(JAN_2026, JAN_2026_TXS);
    expect(result.diffCents).toBe(BigInt(0));
  });

  it("returns declared values from the header", () => {
    const result = reconcileStatement(JAN_2026, JAN_2026_TXS);
    expect(result.declaredStartCents).toBe(BigInt(26296));
    expect(result.declaredEndCents).toBe(BigInt(72895));
    expect(result.declaredCreditsCents).toBe(BigInt(206000));
    expect(result.declaredDebitsCents).toBe(BigInt(159401));
  });

  it("tolerates a 1-cent rounding difference (ok=true)", () => {
    // One cent debit less than declared — closing balance 1 cent off
    const txs: ParsedStatementTx[] = [
      parsedCredit(BigInt(206000)),
      parsedDebit(BigInt(159400)), // one cent less
    ];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false when difference is exactly 2 cents", () => {
    const txs: ParsedStatementTx[] = [
      parsedCredit(BigInt(206000)),
      parsedDebit(BigInt(159399)), // two cents less
    ];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileStatement — 3-statement chain (Ene/Feb/Mar)
// ---------------------------------------------------------------------------

describe("reconcileStatement — 3-statement synthetic chain", () => {
  // Jan: start=26296, credits=206000, debits=159401, end=72895
  // Feb: start=72895, credits=209896, debits=202863, end=79928
  // Mar: start=79928, credits=100000, debits= 80000, end=99928

  const FEB_SUMMARY = {
    balanceStartCents: BigInt(72895),
    totalCreditsCents: BigInt(209896),
    totalDebitsCents: BigInt(202863),
    balanceEndCents: BigInt(79928),
  };
  const MAR_SUMMARY = {
    balanceStartCents: BigInt(79928),
    totalCreditsCents: BigInt(100000),
    totalDebitsCents: BigInt(80000),
    balanceEndCents: BigInt(99928),
  };

  it("January reconciles ok", () => {
    const result = reconcileStatement(JAN_2026, JAN_2026_TXS);
    expect(result.ok).toBe(true);
  });

  it("February reconciles ok", () => {
    const feb = makeStatement(FEB_SUMMARY);
    (feb.header.periodStart as Date) = new Date(Date.UTC(2026, 1, 1));
    (feb.header.periodEnd as Date) = new Date(Date.UTC(2026, 1, 28));
    const txs: ParsedStatementTx[] = [parsedCredit(BigInt(209896)), parsedDebit(BigInt(202863))];
    const result = reconcileStatement(feb, txs);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("March reconciles ok", () => {
    const mar = makeStatement(MAR_SUMMARY);
    (mar.header.periodStart as Date) = new Date(Date.UTC(2026, 2, 1));
    (mar.header.periodEnd as Date) = new Date(Date.UTC(2026, 2, 31));
    const txs: ParsedStatementTx[] = [parsedCredit(BigInt(100000)), parsedDebit(BigInt(80000))];
    const result = reconcileStatement(mar, txs);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reconcileStatement — failure: missing transaction
// ---------------------------------------------------------------------------

describe("reconcileStatement — missing transaction (ok=false)", () => {
  it("returns ok=false when a debit is missing", () => {
    // Remove the debit tx — balance won't reconcile
    const txs: ParsedStatementTx[] = [parsedCredit(BigInt(206000))];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("error message includes account number and period", () => {
    const txs: ParsedStatementTx[] = [parsedCredit(BigInt(206000))];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.errors[0]).toContain("211215197073");
    expect(result.errors[0]).toContain("2026-01-01");
  });

  it("error message includes declared and calculated values", () => {
    const txs: ParsedStatementTx[] = [parsedCredit(BigInt(206000))];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.errors[0]).toContain("declared_end");
    expect(result.errors[0]).toContain("calc_end");
  });

  it("parsedDebitsCents reflects what was actually parsed", () => {
    const txs: ParsedStatementTx[] = [parsedCredit(BigInt(206000))];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.parsedDebitsCents).toBe(BigInt(0)); // no debits parsed
    expect(result.declaredDebitsCents).toBe(BigInt(159401)); // declared had debits
  });
});

// ---------------------------------------------------------------------------
// reconcileStatement — failure: duplicated transaction
// ---------------------------------------------------------------------------

describe("reconcileStatement — duplicated transaction (ok=false)", () => {
  it("returns ok=false when a debit is duplicated", () => {
    const txs: ParsedStatementTx[] = [
      parsedCredit(BigInt(206000)),
      parsedDebit(BigInt(159401)), // original
      parsedDebit(BigInt(159401)), // duplicate
    ];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("parsedDebitsCents = 2× the declared value when duplicated", () => {
    const txs: ParsedStatementTx[] = [
      parsedCredit(BigInt(206000)),
      parsedDebit(BigInt(159401)),
      parsedDebit(BigInt(159401)),
    ];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.parsedDebitsCents).toBe(BigInt(159401) * BigInt(2));
  });
});

// ---------------------------------------------------------------------------
// reconcileStatement — skip entries are ignored
// ---------------------------------------------------------------------------

describe("reconcileStatement — skip entries are excluded from sums", () => {
  it("skip entries do not affect parsedSumCents", () => {
    const rawLine = credit(BigInt(99999), "skip me");
    const txs: ParsedStatementTx[] = [
      parsedCredit(BigInt(206000)),
      parsedDebit(BigInt(159401)),
      parsedSkip(rawLine), // should be ignored
    ];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.ok).toBe(true);
    expect(result.parsedCreditsCents).toBe(BigInt(206000));
    expect(result.parsedDebitsCents).toBe(BigInt(159401));
  });

  it("all-skip list → parsedSumCents = 0 → ok=false (unless balance was 0)", () => {
    const rawLine = debit(BigInt(1000), "skip");
    const txs: ParsedStatementTx[] = [parsedSkip(rawLine)];
    const result = reconcileStatement(JAN_2026, txs);
    expect(result.ok).toBe(false);
    expect(result.parsedSumCents).toBe(BigInt(0));
  });

  it("empty tx list → parsedSumCents = 0", () => {
    const result = reconcileStatement(JAN_2026, []);
    expect(result.parsedSumCents).toBe(BigInt(0));
    expect(result.parsedCreditsCents).toBe(BigInt(0));
    expect(result.parsedDebitsCents).toBe(BigInt(0));
  });
});

// ---------------------------------------------------------------------------
// reconcileStatement — cross-check declared totals independently
// ---------------------------------------------------------------------------

describe("reconcileStatement — credits/debits cross-check", () => {
  it("adds an error when parsedCredits diverge by more than 1 cent from declared", () => {
    // Make a statement where end balance would match but credits are wrong
    // declared: start=0, credits=100, debits=50, end=50
    const stmt = makeStatement({
      balanceStartCents: BigInt(0),
      totalCreditsCents: BigInt(10000), // declared 100.00
      totalDebitsCents: BigInt(5000),
      balanceEndCents: BigInt(5000),
    });
    // parsedCredits = 200.00 (wrong), parsedDebits = 150.00 (also wrong so balance still matches?)
    // Actually let's test: parsed credits too high by 10, debits too high by 10 → end matches
    const txs: ParsedStatementTx[] = [
      parsedCredit(BigInt(11000)), // 10 extra
      parsedDebit(BigInt(6000)), // 10 extra
    ];
    const result = reconcileStatement(stmt, txs);
    // end: 0 + 11000 - 6000 = 5000 = declared → end ok
    // but credits: 11000 ≠ 10000 → error
    // and debits: 6000 ≠ 5000 → error
    expect(result.errors.length).toBeGreaterThan(0);
    const combined = result.errors.join(" ");
    expect(combined).toContain("Credits mismatch");
    expect(combined).toContain("Debits mismatch");
  });
});

// ---------------------------------------------------------------------------
// buildChainCheck — pure function tests
// ---------------------------------------------------------------------------

const JAN_STMT_FOR_CHAIN: RawStatement = {
  header: {
    accountHolder: "TEST",
    accountNumber: "211215197073",
    routingNumber: "101019644",
    periodStart: new Date(Date.UTC(2026, 1, 1)), // Feb 2026 — checking against Jan end
    periodEnd: new Date(Date.UTC(2026, 1, 28)),
    durationDays: 28,
    summary: {
      balanceStartCents: BigInt(72895), // matches Jan end
      totalCreditsCents: BigInt(0),
      totalDebitsCents: BigInt(0),
      balanceEndCents: BigInt(72895),
    },
  },
  transactions: [],
};

describe("buildChainCheck", () => {
  it("chainOk=null when previousEndCents=null (first statement)", () => {
    const result = buildChainCheck(JAN_STMT_FOR_CHAIN, null);
    expect(result.chainOk).toBeNull();
    expect(result.previousEndCents).toBeNull();
    expect(result.diffCents).toBeNull();
  });

  it("chainOk=true when previousEnd matches currentStart exactly", () => {
    const result = buildChainCheck(JAN_STMT_FOR_CHAIN, BigInt(72895));
    expect(result.chainOk).toBe(true);
    expect(result.diffCents).toBe(BigInt(0));
  });

  it("chainOk=true within 1-cent tolerance", () => {
    const result = buildChainCheck(JAN_STMT_FOR_CHAIN, BigInt(72894)); // 1 cent off
    expect(result.chainOk).toBe(true);
  });

  it("chainOk=false when mismatch exceeds 1 cent", () => {
    const result = buildChainCheck(JAN_STMT_FOR_CHAIN, BigInt(70000)); // large gap
    expect(result.chainOk).toBe(false);
  });

  it("diffCents is currentStart − previousEnd (signed)", () => {
    const result = buildChainCheck(JAN_STMT_FOR_CHAIN, BigInt(70000));
    // 72895 − 70000 = 2895
    expect(result.diffCents).toBe(BigInt(72895 - 70000));
  });

  it("currentStartCents is always set from the statement", () => {
    const result = buildChainCheck(JAN_STMT_FOR_CHAIN, null);
    expect(result.currentStartCents).toBe(BigInt(72895));
  });

  it("negative diff when previousEnd > currentStart", () => {
    const result = buildChainCheck(JAN_STMT_FOR_CHAIN, BigInt(90000)); // higher than start
    expect(result.chainOk).toBe(false);
    expect(result.diffCents).toBe(BigInt(72895 - 90000));
    expect(result.diffCents! < BigInt(0)).toBe(true);
  });

  describe("3-statement chain checks", () => {
    // Jan: end=72895, Feb: start=72895→end=79928, Mar: start=79928
    it("Jan→Feb chain ok", () => {
      const febStmt: RawStatement = {
        ...JAN_STMT_FOR_CHAIN,
        header: {
          ...JAN_STMT_FOR_CHAIN.header,
          summary: {
            ...JAN_STMT_FOR_CHAIN.header.summary,
            balanceStartCents: BigInt(72895),
          },
        },
      };
      const result = buildChainCheck(febStmt, BigInt(72895)); // Jan end
      expect(result.chainOk).toBe(true);
    });

    it("Feb→Mar chain ok", () => {
      const marStmt: RawStatement = {
        ...JAN_STMT_FOR_CHAIN,
        header: {
          ...JAN_STMT_FOR_CHAIN.header,
          summary: {
            ...JAN_STMT_FOR_CHAIN.header.summary,
            balanceStartCents: BigInt(79928),
          },
        },
      };
      const result = buildChainCheck(marStmt, BigInt(79928)); // Feb end
      expect(result.chainOk).toBe(true);
    });

    it("skip-Feb gap: Jan→Mar chain mismatch (chainOk=false, not abort)", () => {
      // Mar starts at 79928 but Jan ended at 72895 → mismatch → soft warn
      const marStmt: RawStatement = {
        ...JAN_STMT_FOR_CHAIN,
        header: {
          ...JAN_STMT_FOR_CHAIN.header,
          summary: {
            ...JAN_STMT_FOR_CHAIN.header.summary,
            balanceStartCents: BigInt(79928),
          },
        },
      };
      const result = buildChainCheck(marStmt, BigInt(72895)); // Jan end, skip Feb
      expect(result.chainOk).toBe(false);
      // Result is a warn — caller still proceeds (chainOk never aborts)
      expect(result.diffCents).toBe(BigInt(79928 - 72895));
    });
  });
});
