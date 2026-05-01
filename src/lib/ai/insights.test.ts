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

// ---------------------------------------------------------------------------
// #526 — frozen TRM aggregation in /insights. USD txs with rawData.fx must
// be converted using their FROZEN TRM, not today's rate.
// ---------------------------------------------------------------------------

const FROZEN_TAG = "INSIGHTS_FROZEN_TRM_TEST";
const FROZEN_TRM = 3676.92; // historical
const LIVE_TRM = 4500; // intentionally different so tests can prove which one was used

describe("buildInsightsSummary — #526 frozen TRM aggregation", () => {
  let frozenUserId: number;
  let frozenAccountId: number;

  beforeAll(async () => {
    // Cleanup any leftovers from a previous run.
    await db.delete(users).where(sql`email LIKE ${"%" + FROZEN_TAG + "%"}`);

    const [u] = await db
      .insert(users)
      .values({ email: `${FROZEN_TAG}@test.local`, name: FROZEN_TAG })
      .returning({ id: users.id });
    frozenUserId = u.id;
    await copyCategorySeedsToUser(frozenUserId);

    const [a] = await db
      .insert(accounts)
      .values({
        userId: frozenUserId,
        name: `${FROZEN_TAG} acct`,
        institution: FROZEN_TAG,
        type: "savings",
        currency: "USD",
      })
      .returning({ id: accounts.id });
    frozenAccountId = a.id;

    // USD expense $100.00 (10000 cents) with frozen TRM 3676.92.
    await db.insert(transactions).values({
      userId: frozenUserId,
      accountId: frozenAccountId,
      occurredAt: new Date("2098-06-10"),
      amountCents: BigInt(-10000),
      currency: "USD",
      descriptionRaw: `${FROZEN_TAG} compra dolar`,
      merchant: "Amazon",
      categorySlug: "otros",
      classificationMethod: "manual",
      source: "manual",
      externalId: `${FROZEN_TAG}-frozen-1`,
      channel: "bank",
      rawData: {
        fx: {
          originalCurrency: "USD",
          originalAmountCents: "10000",
          trmToAccountCurrency: FROZEN_TRM,
          trmSource: "statement_frozen",
        },
      },
    });
  });

  afterAll(async () => {
    await db.delete(users).where(sql`email LIKE ${"%" + FROZEN_TAG + "%"}`);
  });

  it("all-cop mode: USD expense aggregates using FROZEN TRM, not live", async () => {
    const summary = await buildInsightsSummary(frozenUserId, "2098-06", LIVE_TRM, db, undefined, {
      displayCurrencyMode: "all-cop",
    });

    // 10000 USD cents * 3676.92 / 100 = 367692 pesos. Sub-cent rounding → 367692.
    expect(summary.totals.expenseCop).toBe(367692);

    // Sanity: live TRM would have produced 10000 * 4500 / 100 = 450000 pesos.
    expect(summary.totals.expenseCop).not.toBe(450000);
  });

  it("native mode: USD expense stays in USD pesos coalesced via LIVE TRM", async () => {
    // Native mode preserves the legacy behavior: txs aggregate per-currency,
    // then coalesce to COP for the summary using the live `copPerUsd` rate.
    const summary = await buildInsightsSummary(frozenUserId, "2098-06", LIVE_TRM, db, undefined, {
      displayCurrencyMode: "native",
    });
    expect(summary.totals.expenseCop).toBe(450000);
  });

  it("all-cop mode: top merchants ordered by FROZEN-TRM converted spend", async () => {
    const summary = await buildInsightsSummary(frozenUserId, "2098-06", LIVE_TRM, db, undefined, {
      displayCurrencyMode: "all-cop",
    });
    const amazon = summary.topMerchants.find((m) => m.merchant === "Amazon");
    expect(amazon).toBeDefined();
    expect(amazon!.spentCop).toBe(367692);
  });

  it("all-cop mode: category 'otros' aggregates via frozen TRM", async () => {
    const summary = await buildInsightsSummary(frozenUserId, "2098-06", LIVE_TRM, db, undefined, {
      displayCurrencyMode: "all-cop",
    });
    const otros = summary.categoriesCurrent.find((c) => c.slug === "otros");
    expect(otros).toBeDefined();
    expect(otros!.spentCop).toBe(367692);
    expect(otros!.txCount).toBe(1);
  });

  it("accounts use LIVE TRM (no historical balance)", async () => {
    // Balance is current state; converting via LIVE TRM is correct (no frozen rate).
    const summary = await buildInsightsSummary(frozenUserId, "2098-06", LIVE_TRM, db, undefined, {
      displayCurrencyMode: "all-cop",
    });
    // The USD account had a -100 USD expense → balance ~-100 USD. Converted
    // at LIVE TRM (4500): -100 * 4500 = -450000 COP pesos.
    const acct = summary.accounts.find((a) => a.name === `${FROZEN_TAG} acct`);
    expect(acct).toBeDefined();
    expect(acct!.balanceCop).toBe(-450000);
  });
});
