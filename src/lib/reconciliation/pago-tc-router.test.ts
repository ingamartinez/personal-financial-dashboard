import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, physicalCards, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { randomUUID } from "node:crypto";
import { applyPagoTcRouting } from "./pago-tc-router";

const TAG = "PAGO_TC_ROUTER_TEST";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createUser(tag: string): Promise<number> {
  const email = `${tag.toLowerCase()}.${Date.now()}@test.local`;
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createPhysicalCard(userId: number): Promise<string> {
  const cardId = randomUUID();
  await db.insert(physicalCards).values({
    id: cardId,
    userId,
    institution: "Bancolombia",
    institutionSlug: "bancolombia",
    name: `${TAG} Mastercard`,
    network: "mastercard",
  });
  return cardId;
}

async function createAccount(
  userId: number,
  opts: {
    type?: "savings" | "credit_card";
    currency?: "COP" | "USD";
    physicalCardId?: string;
  } = {},
): Promise<number> {
  const { type = "savings", currency = "COP", physicalCardId } = opts;
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} ${type} ${currency}`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type,
      currency,
      physicalCardId: physicalCardId ?? null,
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createTransferPair(
  userId: number,
  savingsAccountId: number,
  tcAccountId: number,
  amountCents: bigint,
  occurredAt: Date,
  currency: "COP" | "USD" = "COP",
): Promise<{ groupId: string; debitId: number; creditId: number }> {
  const groupId = randomUUID();
  const descriptionRaw = `Pago TC *7291`;

  const [debit] = await db
    .insert(transactions)
    .values({
      userId,
      accountId: savingsAccountId,
      occurredAt,
      amountCents: -amountCents,
      currency: "COP",
      descriptionRaw,
      source: "gmail_bancolombia",
      channel: "transfer",
      transferGroupId: groupId,
      rawData: { kind: "tc_payment", role: "debit" },
    })
    .returning({ id: transactions.id });

  const [credit] = await db
    .insert(transactions)
    .values({
      userId,
      accountId: tcAccountId,
      occurredAt,
      amountCents,
      currency,
      descriptionRaw,
      source: "gmail_bancolombia",
      channel: "transfer",
      transferGroupId: groupId,
      rawData: { kind: "tc_payment", role: "credit" },
    })
    .returning({ id: transactions.id });

  return { groupId, debitId: debit.id, creditId: credit.id };
}

async function createUsdSyntheticTx(
  userId: number,
  usdAccountId: number,
  amountCents: bigint,
  occurredAt: Date,
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId: usdAccountId,
      occurredAt,
      amountCents,
      currency: "USD",
      descriptionRaw: "ABONO SUCURSAL VIRTUAL",
      source: "csv_reconcile",
      channel: "bank",
      rawData: { statementKind: "extracto_detallado" },
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(physicalCards).where(eq(physicalCards.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function toRow(
  occurredAt: Date,
  amountCents: bigint,
  descriptionRaw: string,
): { occurredAt: Date; amountCents: bigint; direction: "in" | "out"; descriptionRaw: string } {
  return { occurredAt, amountCents, direction: "out", descriptionRaw };
}

// ---------------------------------------------------------------------------
// Fixtures: dates in Bogotá-midnight-UTC format (05:00 UTC)
// ---------------------------------------------------------------------------

const DOLAR_DATE = new Date("2026-03-14T05:00:00Z");
const PESOS_DATE = new Date("2026-01-19T05:00:00Z");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyPagoTcRouting — integration against findash_test", () => {
  let userId: number;
  let savingsAccountId: number;
  let copTcAccountId: number;
  let usdTcAccountId: number;
  let physicalCardId: string;

  beforeAll(async () => {
    userId = await createUser(TAG);
    physicalCardId = await createPhysicalCard(userId);
    savingsAccountId = await createAccount(userId, { type: "savings", currency: "COP" });
    copTcAccountId = await createAccount(userId, {
      type: "credit_card",
      currency: "COP",
      physicalCardId,
    });
    usdTcAccountId = await createAccount(userId, {
      type: "credit_card",
      currency: "USD",
      physicalCardId,
    });
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  // Clean up only transactions between each test to reset state.
  afterAll(async () => {
    await cleanupUser(userId);
  });

  // ---------------------------------------------------------------------------
  // Test 1: existing gmail Pago TC pair on COP twin + savings says PESOS → no-op
  // ---------------------------------------------------------------------------
  describe("PESOS match — existing pair is correct", () => {
    let creditId: number;

    beforeAll(async () => {
      const pair = await createTransferPair(
        userId,
        savingsAccountId,
        copTcAccountId,
        BigInt(151_249_00),
        PESOS_DATE,
        "COP",
      );
      creditId = pair.creditId;
    });

    afterAll(async () => {
      await db.delete(transactions).where(eq(transactions.userId, userId));
    });

    it("detects the PESOS row and leaves the existing pair unchanged", async () => {
      const result = await applyPagoTcRouting({
        userId,
        savingsAccountId,
        rows: [toRow(PESOS_DATE, BigInt(151_249_00), "PAGO SUC VIRT TC MASTER PESOS")],
        database: db,
      });

      expect(result.detected).toBe(1);
      expect(result.noOpPesos).toBeGreaterThanOrEqual(1);
      expect(result.reassignedToUsd).toBe(0);
      expect(result.pendingUsdReassignment).toBe(0);
      expect(result.newPairsInserted).toBe(0);
      expect(result.errors).toHaveLength(0);

      // COP twin credit should still exist (not soft-deleted)
      const [tx] = await db
        .select({ deletedAt: transactions.deletedAt })
        .from(transactions)
        .where(eq(transactions.id, creditId));
      expect(tx?.deletedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: existing gmail pair on COP twin + savings says DOLAR + USD synthetic present
  //         → COP destination soft-deleted, re-paired to USD synthetic
  // ---------------------------------------------------------------------------
  describe("DOLAR match — wrong COP twin, USD synthetic available", () => {
    let copCreditId: number;
    let usdSyntheticId: number;
    let groupId: string;

    beforeAll(async () => {
      const pair = await createTransferPair(
        userId,
        savingsAccountId,
        copTcAccountId,
        BigInt(381_147_38),
        DOLAR_DATE,
        "COP",
      );
      copCreditId = pair.creditId;
      groupId = pair.groupId;

      // USD synthetic on the USD twin (csv_reconcile, same date window)
      usdSyntheticId = await createUsdSyntheticTx(
        userId,
        usdTcAccountId,
        BigInt(98_00), // ~USD 98 at some TRM — exact amount doesn't need to match
        DOLAR_DATE,
      );
    });

    afterAll(async () => {
      await db.delete(transactions).where(eq(transactions.userId, userId));
    });

    it("soft-deletes the COP twin destination and re-pairs savings leg to USD synthetic", async () => {
      const result = await applyPagoTcRouting({
        userId,
        savingsAccountId,
        rows: [toRow(DOLAR_DATE, BigInt(381_147_38), "PAGO SUC VIRT TC MASTER DOLAR")],
        database: db,
      });

      expect(result.detected).toBe(1);
      expect(result.reassignedToUsd).toBe(1);
      expect(result.pendingUsdReassignment).toBe(0);
      expect(result.errors).toHaveLength(0);

      // COP credit should now be soft-deleted
      const [copTx] = await db
        .select({ deletedAt: transactions.deletedAt, rawData: transactions.rawData })
        .from(transactions)
        .where(eq(transactions.id, copCreditId));
      expect(copTx?.deletedAt).not.toBeNull();
      expect((copTx?.rawData as Record<string, unknown>).softDeletedReason).toBe(
        "issue-567-savings-parser-detected-DOLAR",
      );

      // USD synthetic should now be in the same transfer group as the savings leg
      const [usdTx] = await db
        .select({ transferGroupId: transactions.transferGroupId, channel: transactions.channel })
        .from(transactions)
        .where(eq(transactions.id, usdSyntheticId));
      expect(usdTx?.transferGroupId).toBe(groupId);
      expect(usdTx?.channel).toBe("transfer");
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: existing gmail pair on COP twin + savings says DOLAR + NO USD synthetic
  //         → COP destination soft-deleted, savings leg flagged pendingUsdTwinReassignment
  // ---------------------------------------------------------------------------
  describe("DOLAR match — wrong COP twin, USD synthetic NOT uploaded yet", () => {
    let copCreditId: number;
    let debitId: number;

    beforeAll(async () => {
      const pair = await createTransferPair(
        userId,
        savingsAccountId,
        copTcAccountId,
        BigInt(405_764_64),
        new Date("2026-01-02T05:00:00Z"),
        "COP",
      );
      copCreditId = pair.creditId;
      debitId = pair.debitId;
    });

    afterAll(async () => {
      await db.delete(transactions).where(eq(transactions.userId, userId));
    });

    it("soft-deletes COP destination and flags savings leg with pendingUsdTwinReassignment", async () => {
      const result = await applyPagoTcRouting({
        userId,
        savingsAccountId,
        rows: [
          toRow(
            new Date("2026-01-02T05:00:00Z"),
            BigInt(405_764_64),
            "PAGO SUC VIRT TC MASTER DOLAR",
          ),
        ],
        database: db,
      });

      expect(result.detected).toBe(1);
      expect(result.pendingUsdReassignment).toBe(1);
      expect(result.reassignedToUsd).toBe(0);
      expect(result.errors).toHaveLength(0);

      // COP twin destination should be soft-deleted
      const [copTx] = await db
        .select({ deletedAt: transactions.deletedAt })
        .from(transactions)
        .where(eq(transactions.id, copCreditId));
      expect(copTx?.deletedAt).not.toBeNull();

      // Savings leg (debit) should be flagged
      const [debit] = await db
        .select({ rawData: transactions.rawData })
        .from(transactions)
        .where(eq(transactions.id, debitId));
      expect((debit?.rawData as Record<string, unknown>).pendingUsdTwinReassignment).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: NO existing gmail pair + savings says PESOS → inserts new transfer pair
  // ---------------------------------------------------------------------------
  describe("no gmail pair — savings PESOS row → insert new pair", () => {
    const testDate = new Date("2026-04-14T05:00:00Z");

    afterAll(async () => {
      await db.delete(transactions).where(eq(transactions.userId, userId));
    });

    it("inserts a fresh transfer pair with csv_reconcile source", async () => {
      const result = await applyPagoTcRouting({
        userId,
        savingsAccountId,
        rows: [toRow(testDate, BigInt(130_469_00), "PAGO SUC VIRT TC MASTER PESOS")],
        database: db,
      });

      expect(result.detected).toBe(1);
      expect(result.newPairsInserted).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify both legs were inserted
      const legs = await db
        .select({
          accountId: transactions.accountId,
          amountCents: transactions.amountCents,
          source: transactions.source,
          channel: transactions.channel,
          transferGroupId: transactions.transferGroupId,
        })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.source, "csv_reconcile")));

      expect(legs).toHaveLength(2);
      // Savings debit
      const debit = legs.find((l) => l.amountCents < BigInt(0));
      expect(debit).toBeDefined();
      expect(debit?.accountId).toBe(savingsAccountId);
      expect(debit?.channel).toBe("transfer");
      // TC credit
      const credit = legs.find((l) => l.amountCents > BigInt(0));
      expect(credit).toBeDefined();
      expect(credit?.accountId).toBe(copTcAccountId);
      expect(credit?.channel).toBe("transfer");
      // Same group
      expect(debit?.transferGroupId).toBe(credit?.transferGroupId);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: PAGO AUTOM variant is handled the same as PAGO SUC VIRT
  // ---------------------------------------------------------------------------
  describe("PAGO AUTOM TC MASTER PESOS variant", () => {
    const testDate = new Date("2026-02-16T05:00:00Z");

    afterAll(async () => {
      await db.delete(transactions).where(eq(transactions.userId, userId));
    });

    it("detects PAGO AUTOM as a Pago TC row and routes correctly", async () => {
      const result = await applyPagoTcRouting({
        userId,
        savingsAccountId,
        rows: [toRow(testDate, BigInt(140_976_98), "PAGO AUTOM TC MASTER PESOS")],
        database: db,
      });

      expect(result.detected).toBe(1);
      // No existing pair → should insert
      expect(result.newPairsInserted).toBe(1);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: non-Pago TC rows are ignored
  // ---------------------------------------------------------------------------
  it("ignores rows that are not pago tc (ABONO INTERESES, TRANSFERENCIA, etc.)", async () => {
    const result = await applyPagoTcRouting({
      userId,
      savingsAccountId,
      rows: [
        {
          occurredAt: new Date(),
          amountCents: BigInt(100),
          direction: "in" as const,
          descriptionRaw: "ABONO INTERESES AHORROS",
        },
        {
          occurredAt: new Date(),
          amountCents: BigInt(500),
          direction: "out" as const,
          descriptionRaw: "PAGO QR PELUQUERIA",
        },
        {
          occurredAt: new Date(),
          amountCents: BigInt(200),
          direction: "out" as const,
          descriptionRaw: "TRANSFERENCIA CTA SUC VIRTUAL",
        },
      ],
      database: db,
    });

    expect(result.detected).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: already deleted destination (manual cleanup) + DOLAR + USD synthetic
  //         → linkUsdSynthetic still runs
  // ---------------------------------------------------------------------------
  describe("DOLAR match — destination already manually deleted", () => {
    let usdSyntheticId: number;
    let groupId: string;

    beforeAll(async () => {
      const pair = await createTransferPair(
        userId,
        savingsAccountId,
        copTcAccountId,
        BigInt(377_575_34),
        new Date("2026-02-13T05:00:00Z"),
        "COP",
      );
      groupId = pair.groupId;

      // Simulate prior manual cleanup: soft-delete the COP credit
      await db
        .update(transactions)
        .set({ deletedAt: new Date() })
        .where(eq(transactions.id, pair.creditId));

      usdSyntheticId = await createUsdSyntheticTx(
        userId,
        usdTcAccountId,
        BigInt(97_00),
        new Date("2026-02-13T05:00:00Z"),
      );
    });

    afterAll(async () => {
      await db.delete(transactions).where(eq(transactions.userId, userId));
    });

    it("links USD synthetic even when COP destination was already deleted", async () => {
      const result = await applyPagoTcRouting({
        userId,
        savingsAccountId,
        rows: [
          toRow(
            new Date("2026-02-13T05:00:00Z"),
            BigInt(377_575_34),
            "PAGO SUC VIRT TC MASTER DOLAR",
          ),
        ],
        database: db,
      });

      expect(result.detected).toBe(1);
      expect(result.reassignedToUsd).toBe(1);
      expect(result.errors).toHaveLength(0);

      const [usdTx] = await db
        .select({ transferGroupId: transactions.transferGroupId })
        .from(transactions)
        .where(eq(transactions.id, usdSyntheticId));
      expect(usdTx?.transferGroupId).toBe(groupId);
    });
  });
});
