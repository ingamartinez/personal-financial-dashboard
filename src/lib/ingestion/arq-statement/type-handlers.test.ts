// Tests for ARQ statement type handlers.
//
// Tests run against synthetic RawTxLine fixtures that mirror the real
// January / February 2026 statement samples listed in issue #514.
// No real PDFs are committed (PII). All monetary figures are in cents.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseStatementTransactions } from "./type-handlers";
import type { RawStatement, RawTxLine } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RawStatement wrapping a single transaction line. */
function stmtWith(tx: RawTxLine): RawStatement {
  return {
    header: {
      accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
      accountNumber: "211215197073",
      routingNumber: "101019644",
      periodStart: new Date(Date.UTC(2026, 0, 1)), // 2026-01-01
      periodEnd: new Date(Date.UTC(2026, 0, 31)), // 2026-01-31
      durationDays: 31,
      summary: {
        balanceStartCents: BigInt(26296),
        totalCreditsCents: BigInt(206000),
        totalDebitsCents: BigInt(159401),
        balanceEndCents: BigInt(72895),
      },
    },
    transactions: [tx],
  };
}

function stmtWithFeb(tx: RawTxLine): RawStatement {
  return {
    header: {
      accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
      accountNumber: "211215197073",
      routingNumber: "101019644",
      periodStart: new Date(Date.UTC(2026, 1, 1)), // 2026-02-01
      periodEnd: new Date(Date.UTC(2026, 1, 28)), // 2026-02-28
      durationDays: 28,
      summary: {
        balanceStartCents: BigInt(72895),
        totalCreditsCents: BigInt(209896),
        totalDebitsCents: BigInt(202863),
        balanceEndCents: BigInt(79928),
      },
    },
    transactions: [tx],
  };
}

// ---------------------------------------------------------------------------
// Sample raw lines (from issue #514 — real statement values, redacted names)
// ---------------------------------------------------------------------------

// Jan 01  Pago con tarjeta  -18.03  COP  -67,440  TIENDA D1 BODEGA ESTRE
const pagoConTarjetaCOP: RawTxLine = {
  date: new Date(Date.UTC(2026, 0, 1)),
  type: "Pago con tarjeta",
  amountCents: BigInt(-1803), // -$18.03 USDc
  equivalentCurrency: "COP",
  equivalentAmountCents: BigInt(-6744000), // -$67,440.00 COP
  description: "TIENDA D1 BODEGA ESTRE",
};

// Jan 13  Pago con tarjeta  -2.99  USD  -2.99  GUMROAD* NOAH NUEBLING
const pagoConTarjetaUSD: RawTxLine = {
  date: new Date(Date.UTC(2026, 0, 13)),
  type: "Pago con tarjeta",
  amountCents: BigInt(-299),
  equivalentCurrency: "USD",
  equivalentAmountCents: BigInt(-299),
  description: "GUMROAD* NOAH NUEBLING",
};

// Jan 13  Compra USDc  +2,060  USD  +2,060  CODEBRANCH LLC
const compraUsdc: RawTxLine = {
  date: new Date(Date.UTC(2026, 0, 13)),
  type: "Compra USDc",
  amountCents: BigInt(206000),
  equivalentCurrency: "USD",
  equivalentAmountCents: BigInt(206000),
  description: "CODEBRANCH LLC",
};

// Jan 14  Venta USDc  -331.91  COP  -1,200,000  Aida Mercedes Maldonado Ramos
const ventaUsdc: RawTxLine = {
  date: new Date(Date.UTC(2026, 0, 14)),
  type: "Venta USDc",
  amountCents: BigInt(-33191), // -$331.91 USDc
  equivalentCurrency: "COP",
  equivalentAmountCents: BigInt(-120000000), // -$1,200,000.00 COP
  description: "Aida Mercedes Maldonado Ramos",
};

// Jan 02  Transferencia P2P  -62  USDc  -62  Dilan Dario Dejanon
const transferenciaP2PUsdc: RawTxLine = {
  date: new Date(Date.UTC(2026, 0, 2)),
  type: "Transferencia P2P",
  amountCents: BigInt(-6200),
  equivalentCurrency: "USDc",
  equivalentAmountCents: BigInt(-6200),
  description: "Dilan Dario Dejanon",
};

// Jan 27  Transferencia P2P  -86.88  COP  -315,000  Dilan Dario Dejanon
const transferenciaP2PCOP: RawTxLine = {
  date: new Date(Date.UTC(2026, 0, 27)),
  type: "Transferencia P2P",
  amountCents: BigInt(-8688),
  equivalentCurrency: "COP",
  equivalentAmountCents: BigInt(-31500000), // -315,000.00 COP
  description: "Dilan Dario Dejanon",
};

// Jan 12  Comisión  -6.99  N/A  N/A  DolarApp subscription
const comision: RawTxLine = {
  date: new Date(Date.UTC(2026, 0, 12)),
  type: "Comisión",
  amountCents: BigInt(-699),
  equivalentCurrency: null,
  equivalentAmountCents: null,
  description: "DolarApp subscription",
};

// Feb 12  Cashback  +32.48  USDc  +32.48  Cashback
const cashback: RawTxLine = {
  date: new Date(Date.UTC(2026, 1, 12)),
  type: "Cashback",
  amountCents: BigInt(3248),
  equivalentCurrency: "USDc",
  equivalentAmountCents: BigInt(3248),
  description: "Cashback",
};

// Feb 28  Beneficio  +6.48  N/A  N/A  Pago beneficio mensual
const beneficio: RawTxLine = {
  date: new Date(Date.UTC(2026, 1, 28)),
  type: "Beneficio",
  amountCents: BigInt(648),
  equivalentCurrency: null,
  equivalentAmountCents: null,
  description: "Pago beneficio mensual",
};

// ---------------------------------------------------------------------------
// Handler: Pago con tarjeta (COP)
// ---------------------------------------------------------------------------

describe("handler: Pago con tarjeta (COP)", () => {
  it("produces kind=purchase", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    expect(result.kind).toBe("purchase");
  });

  it("preserves occurredAt", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    expect(result.kind).toBe("purchase");
    if (result.kind !== "purchase") return;
    expect(result.occurredAt).toEqual(new Date(Date.UTC(2026, 0, 1)));
  });

  it("sets amountUsdc as signed bigint cents", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.amountUsdc).toBe(BigInt(-1803));
  });

  it("sets originalCurrency = COP", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.originalCurrency).toBe("COP");
  });

  it("stores originalAmount as absolute cents", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.originalAmount).toBe(BigInt(6744000));
    expect(result.originalAmount >= BigInt(0)).toBe(true);
  });

  it("calculates trmCopPerUsdc as a number", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(typeof result.trmCopPerUsdc).toBe("number");
    // 6_744_000 / 1_803 ≈ 3740.43
    expect(result.trmCopPerUsdc).toBeCloseTo(3740.43, 0);
  });

  it("normalises merchant name (trims and collapses whitespace)", () => {
    const dirtyLine: RawTxLine = {
      ...pagoConTarjetaCOP,
      description: "  TIENDA  D1  BODEGA  ",
    };
    const [result] = parseStatementTransactions(stmtWith(dirtyLine));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.merchant).toBe("TIENDA D1 BODEGA");
  });

  it("sets externalIdPrefix = arq-stmt", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.externalIdPrefix).toBe("arq-stmt");
  });
});

// ---------------------------------------------------------------------------
// Handler: Pago con tarjeta (USD — international / digital)
// ---------------------------------------------------------------------------

describe("handler: Pago con tarjeta (USD direct)", () => {
  it("produces kind=purchase with originalCurrency=USD", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaUSD));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.originalCurrency).toBe("USD");
  });

  it("sets trmCopPerUsdc = null for USD purchases", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaUSD));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.trmCopPerUsdc).toBeNull();
  });

  it("originalAmount is absolute (positive)", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaUSD));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.originalAmount).toBe(BigInt(299));
  });

  it("captures merchant name", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaUSD));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.merchant).toBe("GUMROAD* NOAH NUEBLING");
  });

  // Edge: Claude.ai subscription (USD direct, USD equiv is null-ish fallback)
  it("falls back to amountCents when equivalentAmountCents is null", () => {
    const claudeAi: RawTxLine = {
      date: new Date(Date.UTC(2026, 1, 15)),
      type: "Pago con tarjeta",
      amountCents: BigInt(-10000),
      equivalentCurrency: "USD",
      equivalentAmountCents: null,
      description: "CLAUDE.AI SUBSCRIPTION",
    };
    const [result] = parseStatementTransactions(stmtWithFeb(claudeAi));
    if (result.kind !== "purchase") throw new Error("Expected purchase");
    expect(result.originalAmount).toBe(BigInt(10000));
  });
});

// ---------------------------------------------------------------------------
// Handler: Compra USDc (onramp — USD → USDc)
// ---------------------------------------------------------------------------

describe("handler: Compra USDc", () => {
  it("produces kind=transfer_received", () => {
    const [result] = parseStatementTransactions(stmtWith(compraUsdc));
    expect(result.kind).toBe("transfer_received");
  });

  it("originalCurrency = USD", () => {
    const [result] = parseStatementTransactions(stmtWith(compraUsdc));
    if (result.kind !== "transfer_received") throw new Error("Expected transfer_received");
    expect(result.originalCurrency).toBe("USD");
  });

  it("originalAmount = BigInt(206000) (absolute cents)", () => {
    const [result] = parseStatementTransactions(stmtWith(compraUsdc));
    if (result.kind !== "transfer_received") throw new Error("Expected transfer_received");
    expect(result.originalAmount).toBe(BigInt(206000));
  });

  it("trmCopPerUsdc = null (1:1 rate)", () => {
    const [result] = parseStatementTransactions(stmtWith(compraUsdc));
    if (result.kind !== "transfer_received") throw new Error("Expected transfer_received");
    expect(result.trmCopPerUsdc).toBeNull();
  });

  it("counterparty normalised", () => {
    const [result] = parseStatementTransactions(stmtWith(compraUsdc));
    if (result.kind !== "transfer_received") throw new Error("Expected transfer_received");
    expect(result.counterparty).toBe("CODEBRANCH LLC");
  });
});

// ---------------------------------------------------------------------------
// Handler: Venta USDc (offramp — USDc → COP)
// ---------------------------------------------------------------------------

describe("handler: Venta USDc", () => {
  it("produces kind=transfer_sent", () => {
    const [result] = parseStatementTransactions(stmtWith(ventaUsdc));
    expect(result.kind).toBe("transfer_sent");
  });

  it("originalCurrency = COP", () => {
    const [result] = parseStatementTransactions(stmtWith(ventaUsdc));
    if (result.kind !== "transfer_sent") throw new Error("Expected transfer_sent");
    expect(result.originalCurrency).toBe("COP");
  });

  it("originalAmount = 120_000_BigInt(000) (absolute COP cents)", () => {
    const [result] = parseStatementTransactions(stmtWith(ventaUsdc));
    if (result.kind !== "transfer_sent") throw new Error("Expected transfer_sent");
    expect(result.originalAmount).toBe(BigInt(120000000));
  });

  it("trmCopPerUsdc is a number", () => {
    const [result] = parseStatementTransactions(stmtWith(ventaUsdc));
    if (result.kind !== "transfer_sent") throw new Error("Expected transfer_sent");
    expect(typeof result.trmCopPerUsdc).toBe("number");
  });

  it("trmCopPerUsdc ≈ 3615 (1,200,000 / 331.91)", () => {
    const [result] = parseStatementTransactions(stmtWith(ventaUsdc));
    if (result.kind !== "transfer_sent") throw new Error("Expected transfer_sent");
    // 120_000_000 / 33_191 ≈ 3615.44
    expect(result.trmCopPerUsdc).toBeCloseTo(3615.44, 0);
  });

  it("recipientName normalised", () => {
    const [result] = parseStatementTransactions(stmtWith(ventaUsdc));
    if (result.kind !== "transfer_sent") throw new Error("Expected transfer_sent");
    expect(result.recipientName).toBe("Aida Mercedes Maldonado Ramos");
  });
});

// ---------------------------------------------------------------------------
// Handler: Transferencia P2P (USDc — intra-ARQ)
// ---------------------------------------------------------------------------

describe("handler: Transferencia P2P (USDc)", () => {
  it("produces kind=p2p_transfer", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PUsdc));
    expect(result.kind).toBe("p2p_transfer");
  });

  it("originalCurrency = USDc", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PUsdc));
    if (result.kind !== "p2p_transfer") throw new Error("Expected p2p_transfer");
    expect(result.originalCurrency).toBe("USDc");
  });

  it("originalAmount = BigInt(6200) (absolute cents)", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PUsdc));
    if (result.kind !== "p2p_transfer") throw new Error("Expected p2p_transfer");
    expect(result.originalAmount).toBe(BigInt(6200));
  });

  it("counterparty normalised", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PUsdc));
    if (result.kind !== "p2p_transfer") throw new Error("Expected p2p_transfer");
    expect(result.counterparty).toBe("Dilan Dario Dejanon");
  });

  it("amountUsdc is signed (negative = debit)", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PUsdc));
    if (result.kind !== "p2p_transfer") throw new Error("Expected p2p_transfer");
    expect(result.amountUsdc < BigInt(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handler: Transferencia P2P (COP)
// ---------------------------------------------------------------------------

describe("handler: Transferencia P2P (COP)", () => {
  it("produces kind=p2p_transfer", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PCOP));
    expect(result.kind).toBe("p2p_transfer");
  });

  it("originalCurrency = COP", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PCOP));
    if (result.kind !== "p2p_transfer") throw new Error("Expected p2p_transfer");
    expect(result.originalCurrency).toBe("COP");
  });

  it("originalAmount = 31_500_BigInt(000) (absolute COP cents)", () => {
    const [result] = parseStatementTransactions(stmtWith(transferenciaP2PCOP));
    if (result.kind !== "p2p_transfer") throw new Error("Expected p2p_transfer");
    expect(result.originalAmount).toBe(BigInt(31500000));
  });

  it("counterparty is the same person across both P2P variants", () => {
    const [resultUsdc] = parseStatementTransactions(stmtWith(transferenciaP2PUsdc));
    const [resultCop] = parseStatementTransactions(stmtWith(transferenciaP2PCOP));
    if (resultUsdc.kind !== "p2p_transfer" || resultCop.kind !== "p2p_transfer")
      throw new Error("Expected p2p_transfer");
    expect(resultUsdc.counterparty).toBe(resultCop.counterparty);
  });
});

// ---------------------------------------------------------------------------
// Handler: Comisión
// ---------------------------------------------------------------------------

describe("handler: Comisión", () => {
  it("produces kind=fee", () => {
    const [result] = parseStatementTransactions(stmtWith(comision));
    expect(result.kind).toBe("fee");
  });

  it("feeKind = subscription for DolarApp subscription", () => {
    const [result] = parseStatementTransactions(stmtWith(comision));
    if (result.kind !== "fee") throw new Error("Expected fee");
    expect(result.feeKind).toBe("subscription");
  });

  it("feeKind = other for unknown fee description", () => {
    const otherFee: RawTxLine = {
      ...comision,
      description: "Cargo por servicio externo",
    };
    const [result] = parseStatementTransactions(stmtWith(otherFee));
    if (result.kind !== "fee") throw new Error("Expected fee");
    expect(result.feeKind).toBe("other");
  });

  it("description normalised", () => {
    const [result] = parseStatementTransactions(stmtWith(comision));
    if (result.kind !== "fee") throw new Error("Expected fee");
    expect(result.description).toBe("DolarApp subscription");
  });

  it("amountUsdc = BigInt(-699)", () => {
    const [result] = parseStatementTransactions(stmtWith(comision));
    if (result.kind !== "fee") throw new Error("Expected fee");
    expect(result.amountUsdc).toBe(BigInt(-699));
  });

  it("feeKind = subscription is case-insensitive", () => {
    const mixedCase: RawTxLine = {
      ...comision,
      description: "DOLARAPP SUBSCRIPTION",
    };
    const [result] = parseStatementTransactions(stmtWith(mixedCase));
    if (result.kind !== "fee") throw new Error("Expected fee");
    expect(result.feeKind).toBe("subscription");
  });
});

// ---------------------------------------------------------------------------
// Handler: Cashback
// ---------------------------------------------------------------------------

describe("handler: Cashback", () => {
  it("produces kind=reward", () => {
    const [result] = parseStatementTransactions(stmtWithFeb(cashback));
    expect(result.kind).toBe("reward");
  });

  it("rewardKind = cashback", () => {
    const [result] = parseStatementTransactions(stmtWithFeb(cashback));
    if (result.kind !== "reward") throw new Error("Expected reward");
    expect(result.rewardKind).toBe("cashback");
  });

  it("amountUsdc = +BigInt(3248) (credit)", () => {
    const [result] = parseStatementTransactions(stmtWithFeb(cashback));
    if (result.kind !== "reward") throw new Error("Expected reward");
    expect(result.amountUsdc).toBe(BigInt(3248));
    expect(result.amountUsdc > BigInt(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handler: Beneficio
// ---------------------------------------------------------------------------

describe("handler: Beneficio", () => {
  it("produces kind=reward", () => {
    const [result] = parseStatementTransactions(stmtWithFeb(beneficio));
    expect(result.kind).toBe("reward");
  });

  it("rewardKind = monthly_benefit", () => {
    const [result] = parseStatementTransactions(stmtWithFeb(beneficio));
    if (result.kind !== "reward") throw new Error("Expected reward");
    expect(result.rewardKind).toBe("monthly_benefit");
  });

  it("description normalised", () => {
    const [result] = parseStatementTransactions(stmtWithFeb(beneficio));
    if (result.kind !== "reward") throw new Error("Expected reward");
    expect(result.description).toBe("Pago beneficio mensual");
  });
});

// ---------------------------------------------------------------------------
// Unknown type → skip
// ---------------------------------------------------------------------------

describe("unknown transaction type → skip", () => {
  it("returns kind=skip for an unknown type", () => {
    const unknown: RawTxLine = {
      date: new Date(Date.UTC(2026, 0, 5)),
      type: "Tipo Desconocido",
      amountCents: BigInt(-500),
      equivalentCurrency: "COP",
      equivalentAmountCents: BigInt(-200000),
      description: "Some merchant",
    };
    const [result] = parseStatementTransactions(stmtWith(unknown));
    expect(result.kind).toBe("skip");
  });

  it("skip includes a descriptive reason", () => {
    const unknown: RawTxLine = {
      date: new Date(Date.UTC(2026, 0, 5)),
      type: "Tipo Desconocido",
      amountCents: BigInt(-500),
      equivalentCurrency: null,
      equivalentAmountCents: null,
      description: "Some merchant",
    };
    const [result] = parseStatementTransactions(stmtWith(unknown));
    if (result.kind !== "skip") throw new Error("Expected skip");
    expect(result.reason).toContain("Tipo Desconocido");
  });

  it("preserves the raw line in the skip result", () => {
    const unknown: RawTxLine = {
      date: new Date(Date.UTC(2026, 0, 5)),
      type: "Tipo Desconocido",
      amountCents: BigInt(-500),
      equivalentCurrency: null,
      equivalentAmountCents: null,
      description: "Some merchant",
    };
    const [result] = parseStatementTransactions(stmtWith(unknown));
    if (result.kind !== "skip") throw new Error("Expected skip");
    expect(result.raw).toBe(unknown);
  });

  it("never throws — all 9 real types plus unknown complete without error", () => {
    const allLines = [
      pagoConTarjetaCOP,
      pagoConTarjetaUSD,
      compraUsdc,
      ventaUsdc,
      transferenciaP2PUsdc,
      transferenciaP2PCOP,
      comision,
      cashback,
      beneficio,
      {
        date: new Date(Date.UTC(2026, 0, 5)),
        type: "Tipo Futuro Desconocido",
        amountCents: BigInt(-100),
        equivalentCurrency: null as null,
        equivalentAmountCents: null,
        description: "unknown",
      },
    ];
    const stmt: RawStatement = {
      header: {
        accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
        accountNumber: "211215197073",
        routingNumber: "101019644",
        periodStart: new Date(Date.UTC(2026, 0, 1)),
        periodEnd: new Date(Date.UTC(2026, 1, 28)),
        durationDays: 59,
        summary: {
          balanceStartCents: BigInt(26296),
          totalCreditsCents: BigInt(206000),
          totalDebitsCents: BigInt(159401),
          balanceEndCents: BigInt(72895),
        },
      },
      transactions: allLines,
    };
    expect(() => parseStatementTransactions(stmt)).not.toThrow();
    const results = parseStatementTransactions(stmt);
    expect(results).toHaveLength(allLines.length);
  });
});

// ---------------------------------------------------------------------------
// externalId idempotency
// ---------------------------------------------------------------------------

describe("externalId determinism", () => {
  it("same RawTxLine + same period → same externalId across runs", () => {
    const [r1] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    const [r2] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (r1.kind === "skip" || r2.kind === "skip") throw new Error("Expected non-skip");
    expect(r1.externalId).toBe(r2.externalId);
  });

  it("different lineIndex → different externalId", () => {
    const stmt: RawStatement = {
      header: {
        accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
        accountNumber: "211215197073",
        routingNumber: "101019644",
        periodStart: new Date(Date.UTC(2026, 0, 1)),
        periodEnd: new Date(Date.UTC(2026, 0, 31)),
        durationDays: 31,
        summary: {
          balanceStartCents: BigInt(26296),
          totalCreditsCents: BigInt(206000),
          totalDebitsCents: BigInt(159401),
          balanceEndCents: BigInt(72895),
        },
      },
      // Two identical raw lines at different indices
      transactions: [pagoConTarjetaCOP, pagoConTarjetaCOP],
    };
    const [r0, r1] = parseStatementTransactions(stmt);
    if (r0.kind === "skip" || r1.kind === "skip") throw new Error("Expected non-skip");
    expect(r0.externalId).not.toBe(r1.externalId);
  });

  it("different accountNumber → different externalId", () => {
    const stmt1 = stmtWith(pagoConTarjetaCOP);
    const stmt2: RawStatement = {
      ...stmt1,
      header: { ...stmt1.header, accountNumber: "999999999999" },
    };
    const [r1] = parseStatementTransactions(stmt1);
    const [r2] = parseStatementTransactions(stmt2);
    if (r1.kind === "skip" || r2.kind === "skip") throw new Error("Expected non-skip");
    expect(r1.externalId).not.toBe(r2.externalId);
  });

  it("different periodStart → different externalId", () => {
    const stmt1 = stmtWith(pagoConTarjetaCOP);
    const stmt2: RawStatement = {
      ...stmt1,
      header: {
        ...stmt1.header,
        periodStart: new Date(Date.UTC(2026, 1, 1)),
        periodEnd: new Date(Date.UTC(2026, 1, 28)),
      },
    };
    const [r1] = parseStatementTransactions(stmt1);
    const [r2] = parseStatementTransactions(stmt2);
    if (r1.kind === "skip" || r2.kind === "skip") throw new Error("Expected non-skip");
    expect(r1.externalId).not.toBe(r2.externalId);
  });

  it("externalId is 24 hex chars", () => {
    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (result.kind === "skip") throw new Error("Expected non-skip");
    expect(result.externalId).toMatch(/^[0-9a-f]{24}$/);
  });

  it("matches a manually computed sha256 prefix", () => {
    // Manually compute what the externalId should be for lineIndex=0
    const accountNumber = "211215197073";
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    const raw = pagoConTarjetaCOP;
    const expected = createHash("sha256")
      .update(accountNumber)
      .update("|")
      .update(periodStart.toISOString())
      .update("|")
      .update("0")
      .update("|")
      .update(raw.type)
      .update("|")
      .update(String(raw.amountCents))
      .update("|")
      .update(raw.description)
      .digest("hex")
      .slice(0, 24);

    const [result] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (result.kind === "skip") throw new Error("Expected non-skip");
    expect(result.externalId).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Money invariants — bigint cents everywhere except TRM
// ---------------------------------------------------------------------------

describe("money invariants", () => {
  it("amountUsdc is always bigint", () => {
    const stmt: RawStatement = {
      header: {
        accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
        accountNumber: "211215197073",
        routingNumber: "101019644",
        periodStart: new Date(Date.UTC(2026, 0, 1)),
        periodEnd: new Date(Date.UTC(2026, 1, 28)),
        durationDays: 59,
        summary: {
          balanceStartCents: BigInt(26296),
          totalCreditsCents: BigInt(206000),
          totalDebitsCents: BigInt(159401),
          balanceEndCents: BigInt(72895),
        },
      },
      transactions: [
        pagoConTarjetaCOP,
        pagoConTarjetaUSD,
        compraUsdc,
        ventaUsdc,
        transferenciaP2PUsdc,
        transferenciaP2PCOP,
        comision,
        cashback,
        beneficio,
      ],
    };
    for (const result of parseStatementTransactions(stmt)) {
      if (result.kind === "skip") continue;
      expect(typeof result.amountUsdc).toBe("bigint");
    }
  });

  it("originalAmount is always bigint when present", () => {
    for (const raw of [
      pagoConTarjetaCOP,
      pagoConTarjetaUSD,
      compraUsdc,
      ventaUsdc,
      transferenciaP2PUsdc,
      transferenciaP2PCOP,
    ]) {
      const [result] = parseStatementTransactions(stmtWith(raw));
      if (result.kind === "skip") continue;
      if ("originalAmount" in result) {
        expect(typeof result.originalAmount).toBe("bigint");
      }
    }
  });

  it("trmCopPerUsdc is number (not bigint) when set", () => {
    const [purchase] = parseStatementTransactions(stmtWith(pagoConTarjetaCOP));
    if (purchase.kind !== "purchase") throw new Error("Expected purchase");
    if (purchase.trmCopPerUsdc !== null) {
      expect(typeof purchase.trmCopPerUsdc).toBe("number");
    }

    const [venta] = parseStatementTransactions(stmtWith(ventaUsdc));
    if (venta.kind !== "transfer_sent") throw new Error("Expected transfer_sent");
    expect(typeof venta.trmCopPerUsdc).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("multi-line description is normalised (no double spaces)", () => {
    // The PDF adapter already joins continuation lines with a space; we verify
    // the handler further collapses any residual whitespace.
    const withDoubleSpaces: RawTxLine = {
      ...ventaUsdc,
      description: "Maria  Eugenia   Giraldo   Klinkert",
    };
    const [result] = parseStatementTransactions(stmtWith(withDoubleSpaces));
    if (result.kind !== "transfer_sent") throw new Error("Expected transfer_sent");
    expect(result.recipientName).toBe("Maria Eugenia Giraldo Klinkert");
  });

  it("Comisión with equivalentCurrency=null and equivalentAmountCents=null does not skip", () => {
    const [result] = parseStatementTransactions(stmtWith(comision));
    expect(result.kind).not.toBe("skip");
  });

  it("Beneficio with equivalentCurrency=null and equivalentAmountCents=null does not skip", () => {
    const [result] = parseStatementTransactions(stmtWithFeb(beneficio));
    expect(result.kind).not.toBe("skip");
  });

  it("Pago con tarjeta with USDc equivalentCurrency skips with descriptive reason", () => {
    const badLine: RawTxLine = {
      ...pagoConTarjetaCOP,
      equivalentCurrency: "USDc",
    };
    const [result] = parseStatementTransactions(stmtWith(badLine));
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toContain("Pago con tarjeta");
  });

  it("Venta USDc with USD equivalentCurrency skips", () => {
    const badLine: RawTxLine = {
      ...ventaUsdc,
      equivalentCurrency: "USD",
    };
    const [result] = parseStatementTransactions(stmtWith(badLine));
    expect(result.kind).toBe("skip");
  });

  it("Compra USDc with COP equivalentCurrency skips", () => {
    const badLine: RawTxLine = {
      ...compraUsdc,
      equivalentCurrency: "COP",
    };
    const [result] = parseStatementTransactions(stmtWith(badLine));
    expect(result.kind).toBe("skip");
  });

  it("parseStatementTransactions returns one entry per raw line", () => {
    const stmt: RawStatement = {
      header: {
        accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
        accountNumber: "211215197073",
        routingNumber: "101019644",
        periodStart: new Date(Date.UTC(2026, 0, 1)),
        periodEnd: new Date(Date.UTC(2026, 1, 28)),
        durationDays: 59,
        summary: {
          balanceStartCents: BigInt(26296),
          totalCreditsCents: BigInt(206000),
          totalDebitsCents: BigInt(159401),
          balanceEndCents: BigInt(72895),
        },
      },
      transactions: [pagoConTarjetaCOP, compraUsdc, comision],
    };
    const results = parseStatementTransactions(stmt);
    expect(results).toHaveLength(3);
  });

  it("empty transactions list returns empty array", () => {
    const stmt: RawStatement = {
      header: {
        accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
        accountNumber: "211215197073",
        routingNumber: "101019644",
        periodStart: new Date(Date.UTC(2026, 0, 1)),
        periodEnd: new Date(Date.UTC(2026, 0, 31)),
        durationDays: 31,
        summary: {
          balanceStartCents: BigInt(0),
          totalCreditsCents: BigInt(0),
          totalDebitsCents: BigInt(0),
          balanceEndCents: BigInt(0),
        },
      },
      transactions: [],
    };
    expect(parseStatementTransactions(stmt)).toEqual([]);
  });
});
