import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { buildInsightsSummary } from "./insights";

// Integration test for #685 — verifies that buildInsightsSummary excludes
// channel='transfer' transactions from totals, category breakdowns, and merchant
// aggregations.

const TAG = "INSIGHTS_TRANSFER_TEST";

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

let userId: number;
let accountId: number;

describe("buildInsightsSummary — transfer filter (#685)", () => {
  beforeAll(async () => {
    await cleanup();

    const [u] = await db
      .insert(users)
      .values({ email: `${TAG}@test.local`, name: TAG })
      .returning({ id: users.id });
    userId = u.id;
    await copyCategorySeedsToUser(userId);

    const [a] = await db
      .insert(accounts)
      .values({
        userId,
        name: `${TAG} acct`,
        institution: TAG,
        type: "savings",
        currency: "COP",
      })
      .returning({ id: accounts.id });
    accountId = a.id;

    // Real expense (channel='bank') — should be counted
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-10"),
      amountCents: BigInt(-20000),
      currency: "COP",
      descriptionRaw: `${TAG} compra mercado`,
      merchant: "Exito",
      categorySlug: "mercado",
      classificationMethod: "manual",
      source: "sms",
      externalId: `${TAG}-expense`,
      channel: "bank",
    });

    // TC payment (channel='transfer') — must NOT be counted in expenses
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-15"),
      amountCents: BigInt(-150000),
      currency: "COP",
      descriptionRaw: `${TAG} pago TC Bancolombia`,
      merchant: "Bancolombia",
      categorySlug: null,
      classificationMethod: "manual",
      source: "gmail_bancolombia",
      externalId: `${TAG}-transfer`,
      channel: "transfer",
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("excludes transfer transactions from totals.expenseCop", async () => {
    const summary = await buildInsightsSummary(userId, "2026-04", 4000, db);

    // Only the 20000-cent expense should count — the 150000-cent transfer must be excluded.
    // 20000 cents = $200 COP
    expect(summary.totals.expenseCop).toBe(200);
    expect(summary.totals.incomeCop).toBe(0);
  });

  it("excludes transfer transactions from categoriesCurrent", async () => {
    const summary = await buildInsightsSummary(userId, "2026-04", 4000, db);

    // The transfer has categorySlug=null and channel='transfer' — must not appear
    // in categoriesCurrent (either as a null/uncategorized or as any slug).
    const transferCategory = summary.categoriesCurrent.find((c) => c.slug === null);
    expect(transferCategory).toBeUndefined();

    // Total spent across all categories must equal only the real expense
    const totalSpent = summary.categoriesCurrent.reduce((s, c) => s + c.spentCop, 0);
    expect(totalSpent).toBe(200);
  });

  it("excludes transfer transactions from topMerchants", async () => {
    const summary = await buildInsightsSummary(userId, "2026-04", 4000, db);

    // "Bancolombia" appears only on the transfer tx — must not appear in topMerchants.
    const bancolombia = summary.topMerchants.find((m) => m.merchant === "Bancolombia");
    expect(bancolombia).toBeUndefined();
  });
});
