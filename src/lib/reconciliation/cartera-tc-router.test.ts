import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { insertNewCarteraTcPair } from "./cartera-tc-router";

// #687: Integration tests for insertNewCarteraTcPair.
// Runs against findash_test (forced by vitest.setup.ts).

const TAG = "CARTERA_TC_TEST";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createUser(tag: string): Promise<number> {
  const email = `${tag.toLowerCase()}.${Date.now()}@test.local`;
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccount(
  userId: number,
  opts: {
    type?: "savings" | "credit_card";
    currency?: "COP" | "USD";
  } = {},
): Promise<number> {
  const { type = "savings", currency = "COP" } = opts;
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} ${type} ${currency}`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type,
      currency,
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OCCURRED_AT = new Date("2026-04-23T05:00:00Z");
const AMOUNT = BigInt(2_900_000_00); // $29M COP in cents
const INSTALLMENTS = 60;
const RATE = 13900; // 1.39% EM

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("insertNewCarteraTcPair — integration against findash_test", () => {
  let userId: number;
  let savingsAccountId: number;
  let tcAccountId: number;

  beforeAll(async () => {
    userId = await createUser(TAG);
    savingsAccountId = await createAccount(userId, { type: "savings", currency: "COP" });
    tcAccountId = await createAccount(userId, { type: "credit_card", currency: "COP" });
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("happy path: inserts 2 paired legs with installment fields on TC debit", async () => {
    const result = await insertNewCarteraTcPair({
      userId,
      savingsAccountId,
      tcAccountId,
      amountCents: AMOUNT,
      currency: "COP",
      occurredAt: OCCURRED_AT,
      installmentsTotal: INSTALLMENTS,
      installmentRateEmX10k: RATE,
      source: "csv_reconcile",
      externalIdSavings: `${TAG}-happy-savings`,
      externalIdTc: `${TAG}-happy-tc`,
      originalSmsBody: "Desembolso cartera TC $29.000.000 60 cuotas 1.39%",
    });

    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;

    const rows = await db.execute<{
      account_id: number;
      amount_cents: string;
      channel: string;
      category_slug: string | null;
      installments_total: number;
      installment_rate_bps: number | null;
      raw_data: Record<string, unknown>;
      transfer_group_id: string;
    }>(sql`
      SELECT
        account_id,
        amount_cents::text,
        channel,
        category_slug,
        installments_total,
        installment_rate_bps,
        raw_data,
        transfer_group_id
      FROM transactions
      WHERE transfer_group_id = ${result.transferGroupId}::uuid
        AND user_id = ${userId}
      ORDER BY amount_cents DESC
    `);

    expect(rows.length).toBe(2);

    // Both legs share the same transfer_group_id and channel=transfer.
    for (const row of rows) {
      expect(row.transfer_group_id).toBe(result.transferGroupId);
      expect(row.channel).toBe("transfer");
      expect(row.category_slug).toBeNull();
    }

    // Σ = 0
    const sum = rows.reduce((acc, r) => acc + BigInt(r.amount_cents), BigInt(0));
    expect(sum).toBe(BigInt(0));

    // Savings leg (positive amount)
    const savingsLeg = rows.find((r) => BigInt(r.amount_cents) > BigInt(0));
    expect(savingsLeg).toBeDefined();
    if (!savingsLeg) return;
    expect(savingsLeg.account_id).toBe(savingsAccountId);
    expect(BigInt(savingsLeg.amount_cents)).toBe(AMOUNT);
    expect(savingsLeg.installments_total).toBe(1); // default, not a plan leg
    expect(savingsLeg.installment_rate_bps).toBeNull();
    expect(savingsLeg.raw_data).toMatchObject({ kind: "cartera_tc", role: "savings_disbursement" });

    // TC leg (negative amount)
    const tcLeg = rows.find((r) => BigInt(r.amount_cents) < BigInt(0));
    expect(tcLeg).toBeDefined();
    if (!tcLeg) return;
    expect(tcLeg.account_id).toBe(tcAccountId);
    expect(BigInt(tcLeg.amount_cents)).toBe(-AMOUNT);
    expect(tcLeg.installments_total).toBe(INSTALLMENTS);
    expect(tcLeg.installment_rate_bps).toBe(RATE);
    expect(tcLeg.raw_data).toMatchObject({
      kind: "cartera_tc",
      role: "tc_debit",
      installmentsTotal: INSTALLMENTS,
      installmentRateEmX10k: RATE,
    });
  });

  it("duplicate detection: returns `duplicated` on second call with same externalIds", async () => {
    const sharedOpts = {
      userId,
      savingsAccountId,
      tcAccountId,
      amountCents: BigInt(500_000_00),
      currency: "COP" as const,
      occurredAt: new Date("2026-03-01T05:00:00Z"),
      installmentsTotal: 36,
      installmentRateEmX10k: 15000,
      source: "csv_reconcile" as const,
      externalIdSavings: `${TAG}-dedup-savings`,
      externalIdTc: `${TAG}-dedup-tc`,
    };

    const first = await insertNewCarteraTcPair(sharedOpts);
    expect(first.status).toBe("inserted");

    const second = await insertNewCarteraTcPair(sharedOpts);
    expect(second.status).toBe("duplicated");

    // Only 2 rows exist (the first insert), not 4.
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM transactions
      WHERE user_id = ${userId}
        AND external_id IN (${`${TAG}-dedup-savings`}, ${`${TAG}-dedup-tc`})
    `);
    expect(rows[0].n).toBe("2");
  });

  it("rejects amountCents = 0", async () => {
    const result = await insertNewCarteraTcPair({
      userId,
      savingsAccountId,
      tcAccountId,
      amountCents: BigInt(0),
      currency: "COP",
      occurredAt: OCCURRED_AT,
      installmentsTotal: INSTALLMENTS,
      installmentRateEmX10k: RATE,
      source: "csv_reconcile",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errorReason).toMatch(/positive/);
    }
  });

  it("rejects negative amountCents", async () => {
    const result = await insertNewCarteraTcPair({
      userId,
      savingsAccountId,
      tcAccountId,
      amountCents: BigInt(-100),
      currency: "COP",
      occurredAt: OCCURRED_AT,
      installmentsTotal: INSTALLMENTS,
      installmentRateEmX10k: RATE,
      source: "csv_reconcile",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errorReason).toMatch(/positive/);
    }
  });

  it("does NOT inflate expense or income totals (channel=transfer, category_slug=null)", async () => {
    // Baseline expense sum for this user before inserting.
    const before = await db.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(amount_cents), 0)::text AS total
      FROM transactions
      WHERE user_id = ${userId}
        AND deleted_at IS NULL
        AND channel <> 'transfer'
    `);
    const beforeTotal = BigInt(before[0].total);

    await insertNewCarteraTcPair({
      userId,
      savingsAccountId,
      tcAccountId,
      amountCents: BigInt(1_000_000_00),
      currency: "COP",
      occurredAt: new Date("2026-02-01T05:00:00Z"),
      installmentsTotal: 24,
      installmentRateEmX10k: 12000,
      source: "csv_reconcile",
      externalIdSavings: `${TAG}-nokpi-savings`,
      externalIdTc: `${TAG}-nokpi-tc`,
    });

    const after = await db.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(amount_cents), 0)::text AS total
      FROM transactions
      WHERE user_id = ${userId}
        AND deleted_at IS NULL
        AND channel <> 'transfer'
    `);
    const afterTotal = BigInt(after[0].total);

    // Non-transfer sum must be unchanged.
    expect(afterTotal).toBe(beforeTotal);
  });

  // ---------------------------------------------------------------------------
  // Fix #1 — cross-tenant ownership guard
  // ---------------------------------------------------------------------------

  it("rejects when savingsAccountId belongs to a different user", async () => {
    // User B owns the savings account passed as savingsAccountId.
    const userBId = await createUser(`${TAG}_B`);
    const userBSavingsId = await createAccount(userBId, { type: "savings", currency: "COP" });

    try {
      const result = await insertNewCarteraTcPair({
        userId, // user A's userId
        savingsAccountId: userBSavingsId, // belongs to user B — ownership fails
        tcAccountId, // belongs to user A
        amountCents: BigInt(500_000_00),
        currency: "COP",
        occurredAt: OCCURRED_AT,
        installmentsTotal: INSTALLMENTS,
        installmentRateEmX10k: RATE,
        source: "csv_reconcile",
        externalIdSavings: `${TAG}-xuser-savings`,
        externalIdTc: `${TAG}-xuser-tc`,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorReason).toMatch(/does not belong to user/);
      }

      // Zero transactions must have been inserted for this external_id pair.
      const rows = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n
        FROM transactions
        WHERE external_id IN (${`${TAG}-xuser-savings`}, ${`${TAG}-xuser-tc`})
      `);
      expect(rows[0].n).toBe("0");
    } finally {
      await cleanupUser(userBId);
    }
  });

  it("rejects when tcAccountId is archived (soft-deleted)", async () => {
    // Archive the TC account via deleted_at.
    const archivedTcId = await createAccount(userId, { type: "credit_card", currency: "COP" });
    await db.execute(sql`
      UPDATE accounts SET deleted_at = NOW() WHERE id = ${archivedTcId}
    `);

    const result = await insertNewCarteraTcPair({
      userId,
      savingsAccountId,
      tcAccountId: archivedTcId, // archived — notDeleted filter excludes it
      amountCents: BigInt(500_000_00),
      currency: "COP",
      occurredAt: OCCURRED_AT,
      installmentsTotal: INSTALLMENTS,
      installmentRateEmX10k: RATE,
      source: "csv_reconcile",
      externalIdSavings: `${TAG}-archived-savings`,
      externalIdTc: `${TAG}-archived-tc`,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errorReason).toMatch(/does not belong to user/);
    }

    // Zero transactions inserted.
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM transactions
      WHERE external_id IN (${`${TAG}-archived-savings`}, ${`${TAG}-archived-tc`})
    `);
    expect(rows[0].n).toBe("0");

    // Cleanup the archived account (hard delete since cleanupUser won't reach it
    // via deleted_at filter — delete directly).
    await db.execute(sql`DELETE FROM accounts WHERE id = ${archivedTcId}`);
  });

  // ---------------------------------------------------------------------------
  // Fix #3 — installmentsTotal boundary guard
  // ---------------------------------------------------------------------------

  it("rejects installmentsTotal = 1 with cartera-specific error message", async () => {
    const result = await insertNewCarteraTcPair({
      userId,
      savingsAccountId,
      tcAccountId,
      amountCents: AMOUNT,
      currency: "COP",
      occurredAt: OCCURRED_AT,
      installmentsTotal: 1, // boundary: must be > 1 for a cartera plan
      installmentRateEmX10k: RATE,
      source: "csv_reconcile",
      externalIdSavings: `${TAG}-inst1-savings`,
      externalIdTc: `${TAG}-inst1-tc`,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errorReason).toMatch(/installmentsTotal must be > 1/);
    }

    // No DB rows inserted.
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM transactions
      WHERE external_id IN (${`${TAG}-inst1-savings`}, ${`${TAG}-inst1-tc`})
    `);
    expect(rows[0].n).toBe("0");
  });
});
