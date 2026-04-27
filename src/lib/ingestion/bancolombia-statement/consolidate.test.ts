import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, physicalCards, statementImports, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

import { consolidateCycleFromStatement } from "./consolidate";
import type { ParsedStatement, StatementRow } from "./types";

const TAG = "STMT_CONSOL_TEST";

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createTCAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} visa`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "credit_card",
      currency: "COP",
      metadata: { last4s: ["2575"], cutoffDay: 30 },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function insertTx(args: {
  userId: number;
  accountId: number;
  occurredAt: Date;
  amountCents: bigint;
  merchant: string;
  installmentsTotal?: number;
  installmentRateEmX10k?: number | null;
  externalId?: string;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: args.userId,
      accountId: args.accountId,
      occurredAt: args.occurredAt,
      amountCents: args.amountCents,
      currency: "COP",
      descriptionRaw: args.merchant,
      merchant: args.merchant,
      installmentsTotal: args.installmentsTotal ?? 1,
      installmentRateEmX10k: args.installmentRateEmX10k ?? null,
      source: "sms",
      channel: "bank",
      externalId: args.externalId ?? null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

function buildParsed(
  rows: StatementRow[],
  overrides: Partial<ParsedStatement> = {},
): ParsedStatement {
  return {
    account: { last4: "2575", currency: "COP" },
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
    ...overrides,
  };
}

function row(
  partial: Partial<StatementRow> &
    Pick<StatementRow, "amountCents" | "merchant" | "occurredAt" | "authorizationNumber">,
): StatementRow {
  return {
    kind: "kind" in partial ? (partial.kind as StatementRow["kind"]) : "during-period",
    authorizationNumber: partial.authorizationNumber,
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

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(statementImports).where(eq(statementImports.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe("consolidateCycleFromStatement — integration against findash_test", () => {
  let userId!: number;
  let accountId!: number;
  // Four seeded txs: three match-candidates + one unmatched outlier.
  let txExact!: number; // 1/1, already settled — willChange=false
  let txGainsCuotas!: number; // currently 1/1 in DB, statement says 1/6
  let txGetsRate!: number; // currently rate=null, statement says 19110
  let txUnmatched!: number; // in DB but not in statement

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    accountId = await createTCAccount(userId);

    // Ledger sign convention: TC purchases are stored NEGATIVE (expenses).
    // The statement we build below uses the extracto convention (compra+)
    // and the matcher inverts on the way in.
    txExact = await insertTx({
      userId,
      accountId,
      occurredAt: utcDate(2026, 3, 26),
      amountCents: BigInt(-1895200),
      merchant: "DLO*DIDI",
    });
    txGainsCuotas = await insertTx({
      userId,
      accountId,
      occurredAt: utcDate(2026, 3, 26),
      amountCents: BigInt(-9658100),
      merchant: "MERCADOPAGO COLOMBIA L",
    });
    txGetsRate = await insertTx({
      userId,
      accountId,
      occurredAt: utcDate(2026, 2, 14),
      amountCents: BigInt(-24650000),
      merchant: "AIRBNB",
      installmentsTotal: 2,
      installmentRateEmX10k: null,
    });
    txUnmatched = await insertTx({
      userId,
      accountId,
      occurredAt: utcDate(2026, 3, 28),
      amountCents: BigInt(-7777),
      merchant: "GHOST",
    });
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  function buildFixtureStatement(): ParsedStatement {
    return buildParsed([
      // Synthetic INTERESES CORRIENTES — must be skipped entirely.
      {
        kind: "during-period",
        authorizationNumber: null,
        merchant: "INTERESES CORRIENTES",
        occurredAt: utcDate(2026, 3, 30),
        amountCents: BigInt(5000),
        installments: null,
        installmentValueCents: BigInt(5000),
        rateEmX10k: null,
        saldoPendingCents: BigInt(0),
      },
      // Exact existing, 1/1 — no change expected.
      row({
        authorizationNumber: "052000",
        merchant: "DLO*DIDI",
        occurredAt: utcDate(2026, 3, 26),
        amountCents: BigInt(1895200),
      }),
      // Existing at 1/1, statement says 1/6 — willChange via installments.
      row({
        authorizationNumber: "165379",
        merchant: "MERCADOPAGO COLOMBIA L",
        occurredAt: utcDate(2026, 3, 26),
        amountCents: BigInt(9658100),
        installments: { paid: 1, total: 6 },
        installmentValueCents: BigInt(1609683),
        rateEmX10k: 0,
      }),
      // Before-period row: existing tx has null rate, statement reports 19110.
      row({
        kind: "before-period",
        authorizationNumber: "546716",
        merchant: "AIRBNB",
        occurredAt: utcDate(2026, 2, 14),
        amountCents: BigInt(24650000),
        installments: { paid: 2, total: 2 },
        installmentValueCents: BigInt(23965278),
        rateEmX10k: 19110,
      }),
      // Missing during-period — parser saw a purchase we don't have.
      row({
        authorizationNumber: "999999",
        merchant: "NEW MERCHANT",
        occurredAt: utcDate(2026, 3, 20),
        amountCents: BigInt(300000),
      }),
    ]);
  }

  it("dry-run reports correct stats without DB writes", async () => {
    const report = await consolidateCycleFromStatement({
      userId,
      accountId,
      cycle: "2026-03",
      parsed: buildFixtureStatement(),
      fileHash: "deadbeef".repeat(8),
      dryRun: true,
    });
    expect(report.status).toBe("dry-run");
    expect(report.matchStats.matched).toBe(3);
    // 3 willChange because all three tx's rate is null in DB and the statement
    // reports an explicit rate (0 for the 1/1 exact match, 19110 for the
    // other two). Writing the bank's explicit "rate=0" on 1/1 purchases is
    // desired: it says "confirmed non-financed" instead of "unknown".
    expect(report.matchStats.matchedWillChange).toBe(3);
    expect(report.matchStats.insertedMissing).toBe(1);
    expect(report.matchStats.skippedMissingBefore).toBe(0);
    expect(report.matchStats.unmatchedInLedger).toBe(1);
    expect(report.statementImportId).toBeNull();

    // No statement_imports row should exist yet.
    const imports = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(imports).toHaveLength(0);

    // DB rows unchanged.
    const [unchangedTx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txGainsCuotas));
    expect(unchangedTx.installmentsTotal).toBe(1);
  });

  it("commit applies UPDATEs, INSERTs missing, creates synthetic intereses, and records statement_imports", async () => {
    const report = await consolidateCycleFromStatement({
      userId,
      accountId,
      cycle: "2026-03",
      parsed: buildFixtureStatement(),
      fileHash: "cafebabe".repeat(8),
      dryRun: false,
    });
    expect(report.status).toBe("consolidated");
    expect(report.matchedTxIds.sort((a, b) => a - b)).toEqual(
      [txExact, txGainsCuotas, txGetsRate].sort((a, b) => a - b),
    );
    expect(report.insertedTxIds).toHaveLength(1);
    expect(report.statementImportId).not.toBeNull();

    // Matched + changed tx: installmentsTotal bumped to 6.
    const [updatedCuotas] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txGainsCuotas));
    expect(updatedCuotas.installmentsTotal).toBe(6);
    expect(updatedCuotas.reconciliationStatus).toBe("matched");
    expect(updatedCuotas.statementImportId).toBe(report.statementImportId);

    // Rate-only change:
    const [updatedAirbnb] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txGetsRate));
    expect(updatedAirbnb.installmentRateEmX10k).toBe(19110);

    // The 1/1 exact match had null rate in DB; statement confirms rate=0.
    // We UPDATE it so the row is explicitly "non-financed, reconciled".
    const [updatedExact] = await db.select().from(transactions).where(eq(transactions.id, txExact));
    expect(updatedExact.reconciliationStatus).toBe("matched");
    expect(updatedExact.installmentRateEmX10k).toBe(0);
    expect(updatedExact.installmentsTotal).toBe(1);

    // Inserted missing row with deterministic external_id.
    const [insertedRow] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, report.insertedTxIds[0]));
    expect(insertedRow.merchant).toBe("NEW MERCHANT");
    expect(insertedRow.externalId).toBe(`bancolombia-stmt:${accountId}:2026-03:999999`);
    expect(insertedRow.reconciliationStatus).toBe("imported_from_statement");
    expect(insertedRow.source).toBe("csv_reconcile");

    // intereses-causados job runs at the end. Its outcome depends on whether
    // the reconciled rows yield positive cycle interest — in this fixture all
    // rows fall into "no interest this cycle" (either 1/1, month-1 grace, or
    // final installment), so we only require the job ran (not "not-run").
    expect(report.intereses.status).not.toBe("not-run");
    if (report.intereses.status === "inserted") {
      const [synthetic] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, report.intereses.txId));
      expect(synthetic.categorySlug).toBe("intereses-tc");
    }

    // statement_imports row was persisted with kind + cycle.
    const [imp] = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.id, report.statementImportId!));
    expect(imp.kind).toBe("extracto_detallado");
    expect(imp.cycle).toBe("2026-03");
    if (report.intereses.status === "inserted") {
      expect(imp.syntheticTxId).toBe(report.intereses.txId);
    }
    expect(imp.txnCount).toBe(4); // 3 UPDATEd + 1 INSERTed.
    // #563 — balance_at_end_cents must be persisted from summary.currentBalanceCents.
    // buildParsed uses totalPaymentCents=0 so the fixture yields 0 here.
    expect(imp.balanceAtEndCents).toBe(BigInt(0));

    // The ghost tx stays untouched but surfaces as unmatched in the report.
    expect(report.unmatchedInLedgerIds).toContain(txUnmatched);
  });

  it("second call short-circuits to already-consolidated with no new writes", async () => {
    const txCountBefore = (
      await db.select().from(transactions).where(eq(transactions.userId, userId))
    ).length;
    const importsBefore = (
      await db.select().from(statementImports).where(eq(statementImports.userId, userId))
    ).length;

    const report = await consolidateCycleFromStatement({
      userId,
      accountId,
      cycle: "2026-03",
      parsed: buildFixtureStatement(),
      fileHash: "cafebabe".repeat(8),
      dryRun: false,
    });
    expect(report.status).toBe("already-consolidated");
    expect(report.intereses).toEqual({ status: "not-run", reason: "already-consolidated" });

    const txCountAfter = (
      await db.select().from(transactions).where(eq(transactions.userId, userId))
    ).length;
    const importsAfter = (
      await db.select().from(statementImports).where(eq(statementImports.userId, userId))
    ).length;
    expect(txCountAfter).toBe(txCountBefore);
    expect(importsAfter).toBe(importsBefore);
  });

  it("rejects invalid cycle format loudly", async () => {
    await expect(
      consolidateCycleFromStatement({
        userId,
        accountId,
        cycle: "invalid",
        parsed: buildFixtureStatement(),
        fileHash: "x",
        dryRun: true,
      }),
    ).rejects.toThrow(/cycle must be YYYY-MM/);
  });
});

// ---------------------------------------------------------------------------
// Before-period installment purchase insert (#557)
// ---------------------------------------------------------------------------
// When a before-period row is missing from the ledger AND it has
// installments > 1 AND a rate, consolidate must insert it so the
// intereses-causados job can price it in the current (and future) cycles.
// The externalId is cycle-agnostic ("before" namespace) so consecutive
// cycle consolidations don't insert the same purchase twice.
describe("consolidateCycleFromStatement — before-period installment insert (#557)", () => {
  const BEFORE_PERIOD_CYCLE = "2026-04";
  const TAG3 = "STMT_BEFORE_TEST";
  let userId3!: number;
  let accountId3!: number;

  beforeAll(async () => {
    userId3 = await createUser(`${TAG3.toLowerCase()}.${Date.now()}@test.local`);
    accountId3 = await createTCAccount(userId3);
  });

  afterAll(async () => {
    await cleanupUser(userId3);
  });

  // Builds a ParsedStatement for `BEFORE_PERIOD_CYCLE` that includes one
  // before-period multi-cuota row (ALKOMPRAR-like) and one during-period
  // purchase so there's something to consolidate.
  function buildBeforePeriodStatement(): import("./types").ParsedStatement {
    return buildParsed(
      [
        // Before-period installment purchase — missing from ledger.
        // Should be inserted by the fix.
        row({
          kind: "before-period",
          authorizationNumber: "R06018",
          merchant: "ALKOMPRAR MOLINOS",
          occurredAt: utcDate(2025, 11, 16), // original purchase date
          amountCents: BigInt(99905000), // extracto sign (+) = expense
          installments: { paid: 4, total: 8 },
          rateEmX10k: 18740,
        }),
        // During-period: a regular purchase, no installments.
        row({
          authorizationNumber: "ABC123",
          merchant: "TIENDA LOCAL",
          occurredAt: utcDate(2026, 4, 10),
          amountCents: BigInt(5000000),
        }),
      ],
      {
        period: {
          startDate: utcDate(2026, 3, 31),
          endDate: utcDate(2026, 4, 30),
          dueDate: utcDate(2026, 5, 16),
        },
      },
    );
  }

  it("inserts the before-period installment purchase into the ledger", async () => {
    const report = await consolidateCycleFromStatement({
      userId: userId3,
      accountId: accountId3,
      cycle: BEFORE_PERIOD_CYCLE,
      parsed: buildBeforePeriodStatement(),
      fileHash: "before01".repeat(8),
      dryRun: false,
    });

    expect(report.status).toBe("consolidated");
    // insertedTxIds includes both the before-period row and the during-period row.
    // (plus possibly a synthetic intereses tx via the job)
    // The matchStats should reflect insertedMissing >= 2 (before+during), skippedMissingBefore=0.
    expect(report.matchStats.skippedMissingBefore).toBe(0);

    // Find the ALKOMPRAR tx — it must exist with correct fields.
    const [alkTx] = await db.execute<{
      id: number;
      merchant: string;
      amount_cents: string;
      installments_total: number;
      installment_rate_bps: number;
      external_id: string;
      occurred_at: string;
    }>(sql`
      SELECT id, merchant, amount_cents::text, installments_total,
             installment_rate_bps, external_id, occurred_at::text
      FROM transactions
      WHERE user_id = ${userId3} AND account_id = ${accountId3}
        AND merchant = 'ALKOMPRAR MOLINOS' AND deleted_at IS NULL
      LIMIT 1
    `);
    expect(alkTx).toBeDefined();
    expect(BigInt(alkTx.amount_cents)).toBe(-BigInt(99905000)); // ledger sign inverted
    expect(alkTx.installments_total).toBe(8);
    expect(alkTx.installment_rate_bps).toBe(18740);
    // externalId must use the "before" namespace (cycle-agnostic).
    expect(alkTx.external_id).toMatch(/bancolombia-stmt:\d+:before:R06018/);
    // occurred_at must be the original purchase date from the statement.
    expect(alkTx.occurred_at).toContain("2025-11-16");
  });

  it("does NOT insert a before-period row again when a second consecutive cycle consolidation runs (#557 idempotency)", async () => {
    // First consolidation (BEFORE_PERIOD_CYCLE already ran above, but we
    // need a fresh user to avoid the already-consolidated short-circuit).
    const userId4 = await createUser(`${TAG3.toLowerCase()}.idem.${Date.now()}@test.local`);
    const accountId4 = await createTCAccount(userId4);

    try {
      await consolidateCycleFromStatement({
        userId: userId4,
        accountId: accountId4,
        cycle: BEFORE_PERIOD_CYCLE,
        parsed: buildBeforePeriodStatement(),
        fileHash: "before02".repeat(8),
        dryRun: false,
      });

      // Second cycle: same ALKOMPRAR appears before-period again.
      const NEXT_CYCLE = "2026-05";
      const nextParsed = buildParsed(
        [
          row({
            kind: "before-period",
            authorizationNumber: "R06018",
            merchant: "ALKOMPRAR MOLINOS",
            occurredAt: utcDate(2025, 11, 16),
            amountCents: BigInt(99905000),
            installments: { paid: 5, total: 8 },
            rateEmX10k: 18740,
          }),
        ],
        {
          period: {
            startDate: utcDate(2026, 4, 30),
            endDate: utcDate(2026, 5, 31),
            dueDate: utcDate(2026, 6, 16),
          },
        },
      );
      await consolidateCycleFromStatement({
        userId: userId4,
        accountId: accountId4,
        cycle: NEXT_CYCLE,
        parsed: nextParsed,
        fileHash: "before03".repeat(8),
        dryRun: false,
      });

      // ALKOMPRAR must exist exactly once (not duplicated across the two cycles).
      const rows = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM transactions
        WHERE user_id = ${userId4} AND account_id = ${accountId4}
          AND merchant = 'ALKOMPRAR MOLINOS' AND deleted_at IS NULL
      `);
      expect(rows[0].n).toBe("1");
    } finally {
      await cleanupUser(userId4);
    }
  });

  it("does NOT insert a before-period row that has no rate (would produce needsRate=true anyway)", async () => {
    const userId5 = await createUser(`${TAG3.toLowerCase()}.norate.${Date.now()}@test.local`);
    const accountId5 = await createTCAccount(userId5);

    try {
      const parsed = buildParsed(
        [
          row({
            kind: "before-period",
            authorizationNumber: "Z99999",
            merchant: "SOME INSTALLMENT NO RATE",
            occurredAt: utcDate(2025, 10, 1),
            amountCents: BigInt(50000000),
            installments: { paid: 2, total: 12 },
            rateEmX10k: null, // no rate — should NOT be inserted
          }),
        ],
        {
          period: {
            startDate: utcDate(2026, 3, 31),
            endDate: utcDate(2026, 4, 30),
            dueDate: utcDate(2026, 5, 16),
          },
        },
      );
      const report = await consolidateCycleFromStatement({
        userId: userId5,
        accountId: accountId5,
        cycle: BEFORE_PERIOD_CYCLE,
        parsed,
        fileHash: "before04".repeat(8),
        dryRun: false,
      });

      // skippedMissingBefore=1 because it was not inserted.
      expect(report.matchStats.skippedMissingBefore).toBe(1);

      const rows = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM transactions
        WHERE user_id = ${userId5} AND account_id = ${accountId5}
          AND merchant = 'SOME INSTALLMENT NO RATE' AND deleted_at IS NULL
      `);
      expect(rows[0].n).toBe("0");
    } finally {
      await cleanupUser(userId5);
    }
  });

  it("produces an intereses-causados tx when before-period installment purchase generates interest", async () => {
    const userId6 = await createUser(`${TAG3.toLowerCase()}.intereses.${Date.now()}@test.local`);
    const accountId6 = await createTCAccount(userId6);

    try {
      // Simulates the real scenario: a before-period purchase at 8 cuotas with
      // rate=18740. Purchase date 2025-11-16 → by cycle 2026-04 (anchor Apr 30),
      // monthsBetween(Nov 16, Apr 30) = 5 → paidCount=5 → month 6 has interest.
      const parsed = buildParsed(
        [
          row({
            kind: "before-period",
            authorizationNumber: "R06018",
            merchant: "ALKOMPRAR MOLINOS",
            occurredAt: utcDate(2025, 11, 16),
            amountCents: BigInt(99905000), // $999,050 COP
            installments: { paid: 5, total: 8 },
            rateEmX10k: 18740,
          }),
        ],
        {
          period: {
            startDate: utcDate(2026, 3, 31),
            endDate: utcDate(2026, 4, 30),
            dueDate: utcDate(2026, 5, 16),
          },
        },
      );
      const report = await consolidateCycleFromStatement({
        userId: userId6,
        accountId: accountId6,
        cycle: BEFORE_PERIOD_CYCLE,
        parsed,
        fileHash: "before05".repeat(8),
        dryRun: false,
      });

      expect(report.status).toBe("consolidated");
      // The intereses job runs after the before-period tx is committed.
      // With paidCount>=1 and rate > 0, the job should produce a non-zero result.
      expect(report.intereses.status).toBe("inserted");
      if (report.intereses.status === "inserted") {
        expect(BigInt(report.intereses.totalInterestCentsStr)).toBeGreaterThan(BigInt(0));

        // Verify the synthetic tx was persisted.
        const [synthetic] = await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, report.intereses.txId));
        expect(synthetic.categorySlug).toBe("intereses-tc");
        expect(synthetic.amountCents).toBeLessThan(BigInt(0)); // expense
      }
    } finally {
      await cleanupUser(userId6);
    }
  });
});

// ---------------------------------------------------------------------------
// Refinanciación pairs — auth=000000 externalId collision regression (#556)
// ---------------------------------------------------------------------------
// AMPLIACION DE PLAZO + ABONO AMPLIACION share authorizationNumber="000000".
// Before the fix, externalIdFor generated the same key for both rows causing
// the second onConflictDoNothing to silently discard it. Both must land.
describe("consolidateCycleFromStatement — refinanciación pair (auth=000000)", () => {
  const REFINANCIACION_CYCLE = "2026-05";
  const TAG2 = "STMT_REFIN_TEST";
  let userId2!: number;
  let accountId2!: number;

  beforeAll(async () => {
    userId2 = await createUser(`${TAG2.toLowerCase()}.${Date.now()}@test.local`);
    accountId2 = await createTCAccount(userId2);
  });

  afterAll(async () => {
    await cleanupUser(userId2);
  });

  it("inserts BOTH refinanciación rows despite sharing auth=000000", async () => {
    const AMOUNT = BigInt(409952337);
    const parsed = buildParsed(
      [
        // ABONO: credita el viejo saldo (extracto sign = negative)
        row({
          authorizationNumber: "000000",
          merchant: "ABONO AMPLIACION DE PLA",
          occurredAt: utcDate(2026, 3, 24),
          amountCents: -AMOUNT,
          installments: null,
          rateEmX10k: null,
        }),
        // AMPLIACION: carga el nuevo plazo (extracto sign = positive)
        row({
          authorizationNumber: "000000",
          merchant: "AMPLIACION DE PLAZO",
          occurredAt: utcDate(2026, 3, 24),
          amountCents: AMOUNT,
          installments: { paid: 1, total: 60 },
          rateEmX10k: 19110,
        }),
      ],
      {
        period: {
          startDate: utcDate(2026, 5, 1),
          endDate: utcDate(2026, 5, 31),
          dueDate: utcDate(2026, 6, 16),
        },
      },
    );

    const report = await consolidateCycleFromStatement({
      userId: userId2,
      accountId: accountId2,
      cycle: REFINANCIACION_CYCLE,
      parsed,
      fileHash: "refin".repeat(12).slice(0, 64),
      dryRun: false,
    });

    expect(report.status).toBe("consolidated");
    // Both rows must have been inserted — not 1.
    expect(report.insertedTxIds).toHaveLength(2);

    // Fetch only the two insertedTxIds from the report (not all user txs which
    // may include a synthetic intereses row inserted by applyInteresesCausadosForCycle).
    const [firstTx, secondTx] = await Promise.all(
      report.insertedTxIds.map((id) =>
        db
          .select()
          .from(transactions)
          .where(eq(transactions.id, id))
          .then((rows) => rows[0]),
      ),
    );
    const insertedTxs = [firstTx, secondTx].filter(Boolean);
    expect(insertedTxs).toHaveLength(2);

    const merchants = insertedTxs.map((t) => t.merchant).sort();
    expect(merchants).toEqual(["ABONO AMPLIACION DE PLA", "AMPLIACION DE PLAZO"].sort());

    // AMPLIACION DE PLAZO: extracto +4M → ledger −4M (expense)
    const ampliacion = insertedTxs.find((t) => t.merchant === "AMPLIACION DE PLAZO");
    expect(ampliacion).toBeDefined();
    expect(ampliacion!.amountCents).toBe(-AMOUNT);
    expect(ampliacion!.installmentsTotal).toBe(60);
    expect(ampliacion!.installmentRateEmX10k).toBe(19110);

    // ABONO AMPLIACION: extracto −4M → ledger +4M (credit)
    const abono = insertedTxs.find((t) => t.merchant === "ABONO AMPLIACION DE PLA");
    expect(abono).toBeDefined();
    expect(abono!.amountCents).toBe(AMOUNT);

    // Both externalIds must be distinct (the whole point of the fix).
    expect(ampliacion!.externalId).not.toBe(abono!.externalId);
    expect(ampliacion!.externalId).toContain("000000");
    expect(abono!.externalId).toContain("000000");
  });
});

// ---------------------------------------------------------------------------
// Cross-twin reconciliation (#555)
// ---------------------------------------------------------------------------
// International TC purchases arrive via gmail_bancolombia as COP amounts on
// the COP twin. When the USD statement is consolidated, the matching COP tx
// must be re-assigned to the USD account with the real USD amount.
describe("consolidateCycleFromStatement — cross-twin reconciliation (#555)", () => {
  const CROSS_TWIN_CYCLE = "2026-03";
  const TAG_CT = "STMT_CROSSTWIN_TEST";
  let userIdCT!: number;
  let copAccountId!: number;
  let usdAccountId!: number;
  let physicalCardUUID!: string;

  beforeAll(async () => {
    userIdCT = await createUser(`${TAG_CT.toLowerCase()}.${Date.now()}@test.local`);

    // Insert a physical_card so both accounts can be linked.
    physicalCardUUID = crypto.randomUUID();
    await db.insert(physicalCards).values({
      id: physicalCardUUID,
      userId: userIdCT,
      institution: "Bancolombia",
      network: "mastercard",
      last4: "7291",
      creditLimitCents: BigInt(15_000_000_00),
    });

    // COP twin account
    const [copRow] = await db
      .insert(accounts)
      .values({
        userId: userIdCT,
        name: `${TAG_CT} MC COP`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "COP",
        physicalCardId: physicalCardUUID,
        metadata: { last4s: ["7291"], cutoffDay: 15 },
      })
      .returning({ id: accounts.id });
    copAccountId = copRow.id;

    // USD twin account
    const [usdRow] = await db
      .insert(accounts)
      .values({
        userId: userIdCT,
        name: `${TAG_CT} MC USD`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "USD",
        physicalCardId: physicalCardUUID,
        metadata: { last4s: ["7291"], cutoffDay: 15 },
      })
      .returning({ id: accounts.id });
    usdAccountId = usdRow.id;
  });

  afterAll(async () => {
    await db.delete(transactions).where(eq(transactions.userId, userIdCT));
    await db.delete(statementImports).where(eq(statementImports.userId, userIdCT));
    await db.delete(accounts).where(eq(accounts.userId, userIdCT));
    await db.delete(physicalCards).where(eq(physicalCards.id, physicalCardUUID));
    await db.delete(users).where(eq(users.id, userIdCT));
  });

  it("reassigns a COP gmail tx to the USD account when the USD statement matches it", async () => {
    // Seed a gmail_bancolombia tx on the COP account (how AIRBNB lands today).
    const [airbnbRow] = await db
      .insert(transactions)
      .values({
        userId: userIdCT,
        accountId: copAccountId,
        occurredAt: utcDate(2026, 3, 10),
        amountCents: BigInt(-181479701), // -$1,814,797.01 COP (ledger sign)
        currency: "COP",
        descriptionRaw: "AIRBNB * HMA245HENE",
        merchant: "AIRBNB * HMA245HENE",
        source: "gmail_bancolombia",
        channel: "bank",
      })
      .returning({ id: transactions.id });
    const airbnbTxId = airbnbRow.id;

    // USD statement has the real charge: $484.55 USD.
    const usdStatement = buildParsed(
      [
        row({
          authorizationNumber: "123456",
          merchant: "AIRBNB",
          occurredAt: utcDate(2026, 3, 10),
          amountCents: BigInt(48455), // extracto sign: 484.55 USD
        }),
      ],
      {
        account: { last4: "7291", currency: "USD" },
        period: {
          startDate: utcDate(2026, 2, 28),
          endDate: utcDate(2026, 3, 31),
          dueDate: utcDate(2026, 4, 16),
        },
      },
    );

    const report = await consolidateCycleFromStatement({
      userId: userIdCT,
      accountId: usdAccountId,
      cycle: CROSS_TWIN_CYCLE,
      parsed: usdStatement,
      fileHash: "ct-airbnb-01".repeat(5).slice(0, 64),
      dryRun: false,
    });

    expect(report.status).toBe("consolidated");
    expect(report.matchStats.crossTwinReassigned).toBe(1);
    // Cross-twin reassigned rows are not counted as inserts.
    expect(report.matchStats.insertedMissing).toBe(0);

    // The AIRBNB tx must now live on the USD account.
    const [updatedAirbnb] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, airbnbTxId));
    expect(updatedAirbnb.accountId).toBe(usdAccountId);
    expect(updatedAirbnb.currency).toBe("USD");
    expect(updatedAirbnb.amountCents).toBe(BigInt(-48455)); // ledger-sign
    expect(updatedAirbnb.reconciliationStatus).toBe("matched");
    expect(updatedAirbnb.statementImportId).toBe(report.statementImportId);
    expect(updatedAirbnb.sourceMismatch).toBe(true);

    // sourceMismatchDetails must record the divergence.
    const diffs = updatedAirbnb.sourceMismatchDetails?.diffs ?? [];
    const accountDiff = diffs.find((d) => d.field === "accountId");
    const currencyDiff = diffs.find((d) => d.field === "currency");
    const amountDiff = diffs.find((d) => d.field === "amountCents");
    expect(accountDiff?.fromValue).toBe(String(copAccountId));
    expect(accountDiff?.toValue).toBe(String(usdAccountId));
    expect(currencyDiff?.fromValue).toBe("COP");
    expect(currencyDiff?.toValue).toBe("USD");
    expect(amountDiff?.fromValue).toBe(BigInt(-181479701).toString());
    expect(amountDiff?.toValue).toBe(BigInt(-48455).toString());
  });

  it("skips the cross-twin pass when account has no physicalCardId (single-currency TC)", async () => {
    const userIdSingle = await createUser(
      `${TAG_CT.toLowerCase()}.single.${Date.now()}@test.local`,
    );
    const accountIdSingle = await createTCAccount(userIdSingle);

    try {
      // Seed a gmail tx on the same account (no sibling to look in).
      await db.insert(transactions).values({
        userId: userIdSingle,
        accountId: accountIdSingle,
        occurredAt: utcDate(2026, 3, 10),
        amountCents: BigInt(-181479701),
        currency: "COP",
        descriptionRaw: "AIRBNB * HMA245HENE",
        merchant: "AIRBNB * HMA245HENE",
        source: "gmail_bancolombia",
        channel: "bank",
      });

      // A COP statement for the single-currency account — cross-twin must not error.
      const parsed = buildParsed([
        row({
          authorizationNumber: "SINGLETEST",
          merchant: "TIENDA LOCAL",
          occurredAt: utcDate(2026, 3, 20),
          amountCents: BigInt(5000000),
        }),
      ]);

      const report = await consolidateCycleFromStatement({
        userId: userIdSingle,
        accountId: accountIdSingle,
        cycle: CROSS_TWIN_CYCLE,
        parsed,
        fileHash: "ct-single-01".repeat(5).slice(0, 64),
        dryRun: false,
      });

      expect(report.status).toBe("consolidated");
      expect(report.matchStats.crossTwinReassigned).toBe(0);
      // The AIRBNB tx stays on the COP account (no sibling).
      const [airbnbTx] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userIdSingle),
            eq(transactions.accountId, accountIdSingle),
            eq(transactions.source, "gmail_bancolombia"),
          ),
        );
      expect(airbnbTx.accountId).toBe(accountIdSingle);
    } finally {
      await cleanupUser(userIdSingle);
    }
  });

  it("does NOT reassign when merchantSimilarity is at or below the threshold (no false positives)", async () => {
    const userIdLow = await createUser(`${TAG_CT.toLowerCase()}.low.${Date.now()}@test.local`);

    const physicalCardLowUUID = crypto.randomUUID();
    await db.insert(physicalCards).values({
      id: physicalCardLowUUID,
      userId: userIdLow,
      institution: "Bancolombia",
      creditLimitCents: BigInt(10_000_000_00),
    });

    const [copLow] = await db
      .insert(accounts)
      .values({
        userId: userIdLow,
        name: `${TAG_CT} Low COP`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "COP",
        physicalCardId: physicalCardLowUUID,
        metadata: {},
      })
      .returning({ id: accounts.id });

    const [usdLow] = await db
      .insert(accounts)
      .values({
        userId: userIdLow,
        name: `${TAG_CT} Low USD`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "USD",
        physicalCardId: physicalCardLowUUID,
        metadata: {},
      })
      .returning({ id: accounts.id });

    try {
      // COP tx: completely different merchant name — similarity will be 0.
      const [genericTxRow] = await db
        .insert(transactions)
        .values({
          userId: userIdLow,
          accountId: copLow.id,
          occurredAt: utcDate(2026, 3, 10),
          amountCents: BigInt(-500000),
          currency: "COP",
          descriptionRaw: "SUPERMERCADO XYZ",
          merchant: "SUPERMERCADO XYZ",
          source: "gmail_bancolombia",
          channel: "bank",
        })
        .returning({ id: transactions.id });
      const genericTxId = genericTxRow.id;

      // USD statement row with a completely different merchant.
      const usdStatement = buildParsed(
        [
          row({
            authorizationNumber: "LOW001",
            merchant: "AMAZON WEB SERVICES",
            occurredAt: utcDate(2026, 3, 10),
            amountCents: BigInt(9999),
          }),
        ],
        {
          account: { last4: "7291", currency: "USD" },
          period: {
            startDate: utcDate(2026, 2, 28),
            endDate: utcDate(2026, 3, 31),
            dueDate: utcDate(2026, 4, 16),
          },
        },
      );

      const report = await consolidateCycleFromStatement({
        userId: userIdLow,
        accountId: usdLow.id,
        cycle: CROSS_TWIN_CYCLE,
        parsed: usdStatement,
        fileHash: "ct-low-01".repeat(5).slice(0, 64),
        dryRun: false,
      });

      expect(report.matchStats.crossTwinReassigned).toBe(0);
      // The unmatched USD row must be inserted as a new tx.
      expect(report.matchStats.insertedMissing).toBe(1);

      // The COP generic tx must remain untouched on the COP account.
      const [unchanged] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, genericTxId));
      expect(unchanged.accountId).toBe(copLow.id);
      expect(unchanged.currency).toBe("COP");
    } finally {
      await db.delete(transactions).where(eq(transactions.userId, userIdLow));
      await db.delete(statementImports).where(eq(statementImports.userId, userIdLow));
      await db.delete(accounts).where(eq(accounts.userId, userIdLow));
      await db.delete(physicalCards).where(eq(physicalCards.id, physicalCardLowUUID));
      await db.delete(users).where(eq(users.id, userIdLow));
    }
  });

  it("pickBestCandidate: with two same-day sibling candidates picks the one with higher merchant similarity", async () => {
    const userIdPick = await createUser(`${TAG_CT.toLowerCase()}.pick.${Date.now()}@test.local`);

    const physicalCardPickUUID = crypto.randomUUID();
    await db.insert(physicalCards).values({
      id: physicalCardPickUUID,
      userId: userIdPick,
      institution: "Bancolombia",
      creditLimitCents: BigInt(10_000_000_00),
    });

    const [copPick] = await db
      .insert(accounts)
      .values({
        userId: userIdPick,
        name: `${TAG_CT} Pick COP`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "COP",
        physicalCardId: physicalCardPickUUID,
        metadata: {},
      })
      .returning({ id: accounts.id });

    const [usdPick] = await db
      .insert(accounts)
      .values({
        userId: userIdPick,
        name: `${TAG_CT} Pick USD`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "USD",
        physicalCardId: physicalCardPickUUID,
        metadata: {},
      })
      .returning({ id: accounts.id });

    try {
      // Two COP candidates on the same day — one matches "AIRBNB" well, the
      // other is a generic "COMIDA" (low similarity).
      const [airbnbCopRow] = await db
        .insert(transactions)
        .values({
          userId: userIdPick,
          accountId: copPick.id,
          occurredAt: utcDate(2026, 3, 10),
          amountCents: BigInt(-181479701),
          currency: "COP",
          descriptionRaw: "AIRBNB * HMA245HENE",
          merchant: "AIRBNB * HMA245HENE",
          source: "gmail_bancolombia",
          channel: "bank",
        })
        .returning({ id: transactions.id });

      const [comidaCopRow] = await db
        .insert(transactions)
        .values({
          userId: userIdPick,
          accountId: copPick.id,
          occurredAt: utcDate(2026, 3, 10),
          amountCents: BigInt(-50000),
          currency: "COP",
          descriptionRaw: "COMIDA RAPIDA",
          merchant: "COMIDA RAPIDA",
          source: "gmail_bancolombia",
          channel: "bank",
        })
        .returning({ id: transactions.id });

      // USD statement row for AIRBNB.
      const usdStatement = buildParsed(
        [
          row({
            authorizationNumber: "PICK001",
            merchant: "AIRBNB",
            occurredAt: utcDate(2026, 3, 10),
            amountCents: BigInt(48455),
          }),
        ],
        {
          account: { last4: "7291", currency: "USD" },
          period: {
            startDate: utcDate(2026, 2, 28),
            endDate: utcDate(2026, 3, 31),
            dueDate: utcDate(2026, 4, 16),
          },
        },
      );

      const report = await consolidateCycleFromStatement({
        userId: userIdPick,
        accountId: usdPick.id,
        cycle: CROSS_TWIN_CYCLE,
        parsed: usdStatement,
        fileHash: "ct-pick-01".repeat(5).slice(0, 64),
        dryRun: false,
      });

      expect(report.matchStats.crossTwinReassigned).toBe(1);

      // The AIRBNB tx (higher similarity) must be moved, not the COMIDA tx.
      const [movedAirbnb] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, airbnbCopRow.id));
      expect(movedAirbnb.accountId).toBe(usdPick.id);

      const [untouchedComida] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, comidaCopRow.id));
      expect(untouchedComida.accountId).toBe(copPick.id);
    } finally {
      await db.delete(transactions).where(eq(transactions.userId, userIdPick));
      await db.delete(statementImports).where(eq(statementImports.userId, userIdPick));
      await db.delete(accounts).where(eq(accounts.userId, userIdPick));
      await db.delete(physicalCards).where(eq(physicalCards.id, physicalCardPickUUID));
      await db.delete(users).where(eq(users.id, userIdPick));
    }
  });

  it("idempotency: running consolidate twice does NOT double-reassign the tx", async () => {
    const userIdIdem = await createUser(`${TAG_CT.toLowerCase()}.idem2.${Date.now()}@test.local`);

    const physicalCardIdemUUID = crypto.randomUUID();
    await db.insert(physicalCards).values({
      id: physicalCardIdemUUID,
      userId: userIdIdem,
      institution: "Bancolombia",
      creditLimitCents: BigInt(10_000_000_00),
    });

    const [copIdem] = await db
      .insert(accounts)
      .values({
        userId: userIdIdem,
        name: `${TAG_CT} Idem COP`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "COP",
        physicalCardId: physicalCardIdemUUID,
        metadata: {},
      })
      .returning({ id: accounts.id });

    const [usdIdem] = await db
      .insert(accounts)
      .values({
        userId: userIdIdem,
        name: `${TAG_CT} Idem USD`,
        institution: "Bancolombia",
        institutionSlug: "bancolombia",
        type: "credit_card",
        currency: "USD",
        physicalCardId: physicalCardIdemUUID,
        metadata: {},
      })
      .returning({ id: accounts.id });

    try {
      await db.insert(transactions).values({
        userId: userIdIdem,
        accountId: copIdem.id,
        occurredAt: utcDate(2026, 3, 10),
        amountCents: BigInt(-181479701),
        currency: "COP",
        descriptionRaw: "AIRBNB IDEM",
        merchant: "AIRBNB IDEM",
        source: "gmail_bancolombia",
        channel: "bank",
      });

      const usdStatement = buildParsed(
        [
          row({
            authorizationNumber: "IDEM001",
            merchant: "AIRBNB IDEM",
            occurredAt: utcDate(2026, 3, 10),
            amountCents: BigInt(48455),
          }),
        ],
        {
          account: { last4: "7291", currency: "USD" },
          period: {
            startDate: utcDate(2026, 2, 28),
            endDate: utcDate(2026, 3, 31),
            dueDate: utcDate(2026, 4, 16),
          },
        },
      );

      // First run — should reassign.
      const report1 = await consolidateCycleFromStatement({
        userId: userIdIdem,
        accountId: usdIdem.id,
        cycle: CROSS_TWIN_CYCLE,
        parsed: usdStatement,
        fileHash: "ct-idem-01".repeat(5).slice(0, 64),
        dryRun: false,
      });
      expect(report1.status).toBe("consolidated");
      expect(report1.matchStats.crossTwinReassigned).toBe(1);

      // Second run — already-consolidated short-circuit kicks in.
      const report2 = await consolidateCycleFromStatement({
        userId: userIdIdem,
        accountId: usdIdem.id,
        cycle: CROSS_TWIN_CYCLE,
        parsed: usdStatement,
        fileHash: "ct-idem-01".repeat(5).slice(0, 64),
        dryRun: false,
      });
      expect(report2.status).toBe("already-consolidated");

      // Only 1 tx should exist (no phantom insert on second run).
      const allTxs = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userIdIdem), eq(transactions.accountId, usdIdem.id)));
      // The reassigned tx + possibly a synthetic intereses tx (but definitely no duplicate).
      // The intereses synthetic uses categorySlug="intereses-tc"; filter it out.
      const nonInteresesTxs = allTxs.filter((t) => t.categorySlug !== "intereses-tc");
      expect(nonInteresesTxs).toHaveLength(1);
    } finally {
      await db.delete(transactions).where(eq(transactions.userId, userIdIdem));
      await db.delete(statementImports).where(eq(statementImports.userId, userIdIdem));
      await db.delete(accounts).where(eq(accounts.userId, userIdIdem));
      await db.delete(physicalCards).where(eq(physicalCards.id, physicalCardIdemUUID));
      await db.delete(users).where(eq(users.id, userIdIdem));
    }
  });
});

// ---------------------------------------------------------------------------
// balance_at_end_cents persistence (#563)
// ---------------------------------------------------------------------------
// Verifies that consolidate writes parsed.summary.currentBalanceCents to the
// statement_imports.balance_at_end_cents column on first consolidation.
describe("consolidateCycleFromStatement — balance_at_end_cents persistence (#563)", () => {
  const BALANCE_CYCLE = "2026-06";
  const TAG_BAL = "STMT_BAL_TEST";
  let userIdBal!: number;
  let accountIdBal!: number;

  beforeAll(async () => {
    userIdBal = await createUser(`${TAG_BAL.toLowerCase()}.${Date.now()}@test.local`);
    accountIdBal = await createTCAccount(userIdBal);
  });

  afterAll(async () => {
    await cleanupUser(userIdBal);
  });

  it("persists a non-zero currentBalanceCents as balance_at_end_cents on statement_imports", async () => {
    // Simulate a cycle-end balance of $7,744,665 COP (real value from 2575_MAR2026).
    const CURRENT_BALANCE = BigInt(774466500); // cents

    const parsed = buildParsed(
      [
        row({
          authorizationNumber: "BALTEST1",
          merchant: "BALANCE TEST MERCHANT",
          occurredAt: utcDate(2026, 6, 15),
          amountCents: BigInt(100000),
        }),
      ],
      {
        period: {
          startDate: utcDate(2026, 6, 1),
          endDate: utcDate(2026, 6, 30),
          dueDate: utcDate(2026, 7, 16),
        },
        summary: {
          previousBalanceCents: BigInt(0),
          purchasesCents: BigInt(100000),
          interestCorrientesCents: BigInt(0),
          paymentsCents: BigInt(0),
          minPaymentCents: BigInt(0),
          totalPaymentCents: CURRENT_BALANCE,
          currentBalanceCents: CURRENT_BALANCE,
        },
      },
    );

    const report = await consolidateCycleFromStatement({
      userId: userIdBal,
      accountId: accountIdBal,
      cycle: BALANCE_CYCLE,
      parsed,
      fileHash: "bal563".repeat(10).slice(0, 64),
      dryRun: false,
    });

    expect(report.status).toBe("consolidated");
    expect(report.statementImportId).not.toBeNull();

    const [imp] = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.id, report.statementImportId!));
    // Round-trip: balance_at_end_cents must equal the parsed summary value.
    expect(imp.balanceAtEndCents).toBe(CURRENT_BALANCE);
  });
});
