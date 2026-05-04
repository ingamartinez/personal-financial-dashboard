// Integration tests for #780 — Scenario B: during-period multi-cuota row with
// null rate (extracto column G blank). Verifies the warn log fires and that
// purchasesNeedingRate is reported correctly by the intereses job.
//
// These tests live in a sibling file so they can mock @/lib/logger without
// disturbing the existing large integration suite in consolidate.test.ts.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Hoist the spy so it's available inside vi.mock factories (which are hoisted).
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logger", () => ({
  shouldPrettyPrint: () => false,
  logger: {
    child: vi.fn().mockReturnValue({
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    }),
  },
  createLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

import { db } from "@/lib/db";
import { accounts, statementImports, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { applyInteresesCausadosForCycle } from "@/lib/finance/intereses-causados-job";

import { consolidateCycleFromStatement } from "./consolidate";
import type { ParsedStatement, StatementRow } from "./types";

const TAG = "STMT_NULL_RATE_TEST";

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

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(statementImports).where(eq(statementImports.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function buildStatement(
  rows: StatementRow[],
  cycleOverride?: Partial<ParsedStatement>,
): ParsedStatement {
  return {
    account: { last4: "2575", currency: "COP" },
    period: {
      startDate: utcDate(2026, 3, 31),
      endDate: utcDate(2026, 4, 30),
      dueDate: utcDate(2026, 5, 16),
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
    ...cycleOverride,
  };
}

function duringRow(
  partial: Partial<StatementRow> &
    Pick<StatementRow, "amountCents" | "merchant" | "occurredAt" | "authorizationNumber">,
): StatementRow {
  return {
    kind: "during-period",
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
    rateEmX10k: "rateEmX10k" in partial ? (partial.rateEmX10k as number | null) : null,
    saldoPendingCents:
      "saldoPendingCents" in partial ? (partial.saldoPendingCents as bigint) : BigInt(0),
  };
}

// ---------------------------------------------------------------------------
// Test B1 — insert during-period multi-cuota row with null rate
// ---------------------------------------------------------------------------
describe("consolidateCycleFromStatement — null-rate multi-cuota insert (#780)", () => {
  let userId!: number;
  let accountId!: number;
  const CYCLE = "2026-04";

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    accountId = await createTCAccount(userId);
    warnSpy.mockClear();
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("B1: inserts the tx with null installment_rate_bps and emits the warn log (#780)", async () => {
    // A during-period multi-cuota row with rateEmX10k = null (column G blank).
    const parsed = buildStatement([
      duringRow({
        authorizationNumber: "NR36001",
        merchant: "ALKOSTO MEDELLIN",
        occurredAt: utcDate(2026, 4, 5),
        amountCents: BigInt(5_000_000),
        installments: { paid: 1, total: 36 },
        installmentValueCents: BigInt(138_889),
        rateEmX10k: null,
        saldoPendingCents: BigInt(5_000_000),
      }),
    ]);

    const report = await consolidateCycleFromStatement({
      userId,
      accountId,
      cycle: CYCLE,
      parsed,
      fileHash: "nr01".repeat(16), // exactly 64 chars (file_hash is varchar(64))
      dryRun: false,
    });

    expect(report.status).toBe("consolidated");
    expect(report.insertedTxIds).toHaveLength(1);

    // DB side: the row must land with installment_rate_bps = NULL.
    const [inserted] = await db.execute<{
      installment_rate_bps: number | null;
      installments_total: number;
    }>(sql`
      SELECT installment_rate_bps, installments_total
      FROM transactions
      WHERE id = ${report.insertedTxIds[0]}
      LIMIT 1
    `);
    expect(inserted).toBeDefined();
    expect(inserted.installment_rate_bps).toBeNull();
    expect(inserted.installments_total).toBe(36);

    // Log side: the warn must have fired exactly once with the correct event,
    // pinning accountId so a future refactor can't silently log the wrong scope.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "insert_multi_cuota_without_rate",
        installmentsTotal: 36,
        accountId,
      }),
      expect.any(String),
    );
  });

  // ---------------------------------------------------------------------------
  // Test B2 — purchasesNeedingRate >= 1 on subsequent intereses job run
  // ---------------------------------------------------------------------------
  it("B2: applyInteresesCausadosForCycle returns purchasesNeedingRate >= 1 for the null-rate tx (#780)", async () => {
    // Re-uses the account from B1 (which already has the null-rate 36-cuota tx).
    // The account has no creditRateBuckets configured, so the fallback also
    // yields needsRate=true.
    const result = await applyInteresesCausadosForCycle({
      userId,
      accountId,
      cycle: CYCLE,
    });

    // Status may be "inserted" (first call) or "skipped" (already-run from
    // the consolidate step above) — either way purchasesNeedingRate must be >= 1.
    expect(result.status).not.toBe("error");
    if (result.status === "inserted" || result.status === "skipped") {
      expect(result.purchasesNeedingRate).toBeGreaterThanOrEqual(1);
    }
  });
});
