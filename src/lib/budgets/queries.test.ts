// Integration tests for getBudgetsOverview — runs against findash_test.
// Vitest.setup.ts forces PGDATABASE=findash_test before any import.
//
// Key assertion: transfers (channel='transfer') MUST NOT count as expense
// in the `spentCents` aggregation (#685 — pago-tc double-counting fix).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, budgets, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { getBudgetsOverview } from "@/lib/budgets/queries";

const TAG = "BUDGET_QUERIES_TEST";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} account`,
      institution: TAG,
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function insertTx(
  userId: number,
  accountId: number,
  amountCents: bigint,
  channel: "bank" | "manual" | "transfer",
  occurredAt: Date,
  seq: number,
): Promise<void> {
  await db.insert(transactions).values({
    userId,
    accountId,
    occurredAt,
    amountCents,
    currency: "COP",
    descriptionRaw: `${TAG} tx-${seq}`,
    categorySlug: "otros",
    classificationMethod: "manual",
    source: "manual",
    externalId: `${TAG}-tx-${seq}`,
    channel,
  });
}

async function cleanup() {
  // ON DELETE CASCADE handles downstream rows in tenant tables.
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

let userId: number;
let accountId: number;
const yearMonth = "2099-01"; // Far future — won't collide with real data.
const periodStart = `${yearMonth}-01`;
const rangeStart = new Date(Date.UTC(2099, 0, 1));
const rangeEnd = new Date(Date.UTC(2099, 1, 1));

beforeAll(async () => {
  userId = await createUser(`${TAG}-user@example.com`);
  accountId = await createAccount(userId);

  // Budget: "otros" category, $500K limit for 2099-01.
  await db.insert(budgets).values({
    userId,
    categorySlug: "otros",
    amountCents: BigInt(500_000_00), // $500K COP in cents
    currency: "COP",
    periodStart,
    periodEnd: `${yearMonth}-31`,
    active: true,
  });

  // Tx 1 — real expense (bank, amountCents negative): $200K → should count.
  await insertTx(userId, accountId, BigInt(-200_000_00), "bank", rangeStart, 1);

  // Tx 2 — transfer (channel='transfer'): $150K → must NOT count (#685).
  await insertTx(userId, accountId, BigInt(-150_000_00), "transfer", rangeStart, 2);

  // Tx 3 — real expense (manual): $100K → should count.
  await insertTx(userId, accountId, BigInt(-100_000_00), "manual", rangeStart, 3);

  // Tx 4 — positive (income), not an expense: $50K → should not count.
  await insertTx(userId, accountId, BigInt(50_000_00), "bank", rangeStart, 4);
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getBudgetsOverview", () => {
  it("counts only non-transfer expenses in spentCents", async () => {
    const result = await getBudgetsOverview(userId, yearMonth, {
      start: rangeStart,
      end: rangeEnd,
    });

    const item = result.items.find((i) => i.categorySlug === "otros");
    expect(item).toBeDefined();

    // Expected: $200K (bank) + $100K (manual) = $300K.
    // Transfer ($150K) and income ($50K) must be excluded.
    expect(BigInt(item!.spentCents)).toBe(BigInt(300_000_00));
  });

  it("returns the correct budget amountCents", async () => {
    const result = await getBudgetsOverview(userId, yearMonth, {
      start: rangeStart,
      end: rangeEnd,
    });
    const item = result.items.find((i) => i.categorySlug === "otros");
    expect(item).toBeDefined();
    expect(BigInt(item!.amountCents)).toBe(BigInt(500_000_00));
  });

  it("includes all user categories in the categories list", async () => {
    const result = await getBudgetsOverview(userId, yearMonth);
    // copyCategorySeedsToUser seeds at least one category — list must be non-empty.
    expect(result.categories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #527 — frozen-TRM aggregation. Independent fixture so we can mix USD txs
// with their own rawData.fx blocks and verify per-row conversion.
// ---------------------------------------------------------------------------

const FROZEN_TAG = "BUDGET_FROZEN_TRM_TEST";
const FROZEN_TRM = 3676.92; // historical
const LIVE_TRM = 4500; // intentionally different — proves frozen, not live, was used

async function createUserFrozen(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createCopAccount(userId: number, label: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${FROZEN_TAG} ${label}`,
      institution: FROZEN_TAG,
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function insertUsdTxWithFrozenTrm(
  userId: number,
  accountId: number,
  amountCents: bigint,
  trm: number | null,
  occurredAt: Date,
  seq: number,
): Promise<void> {
  const fxBlock =
    trm === null
      ? {} // simulate a legacy USD tx that never got an fx block
      : {
          fx: {
            originalCurrency: "USD",
            originalAmountCents: amountCents.toString().replace(/^-/, ""),
            trmToAccountCurrency: trm,
            trmSource: "statement_frozen",
          },
        };
  await db.insert(transactions).values({
    userId,
    accountId,
    occurredAt,
    amountCents,
    currency: "USD",
    descriptionRaw: `${FROZEN_TAG} tx-${seq}`,
    categorySlug: "otros",
    classificationMethod: "manual",
    source: "manual",
    externalId: `${FROZEN_TAG}-tx-${seq}`,
    channel: "bank",
    rawData: fxBlock,
  });
}

describe("getBudgetsOverview — #527 frozen TRM aggregation", () => {
  let frozenUserId: number;
  let frozenAccountId: number;
  const ym = "2098-06"; // distinct from the suite above
  const periodStartIso = `${ym}-01`;
  const start = new Date(Date.UTC(2098, 5, 1));
  const end = new Date(Date.UTC(2098, 6, 1));

  beforeAll(async () => {
    frozenUserId = await createUserFrozen(`${FROZEN_TAG}-user@example.com`);
    frozenAccountId = await createCopAccount(frozenUserId, "main");

    // COP budget: $400,000 limit for category "otros".
    await db.insert(budgets).values({
      userId: frozenUserId,
      categorySlug: "otros",
      amountCents: BigInt(400_000_00),
      currency: "COP",
      periodStart: periodStartIso,
      periodEnd: `${ym}-30`,
      active: true,
    });

    // USD tx 1: $100 USD with frozen TRM 3676.92 → 367,692 COP equivalent
    await insertUsdTxWithFrozenTrm(
      frozenUserId,
      frozenAccountId,
      BigInt(-10000),
      FROZEN_TRM,
      start,
      1,
    );

    // USD tx 2: $50 USD WITHOUT a frozen TRM (legacy row)
    await insertUsdTxWithFrozenTrm(frozenUserId, frozenAccountId, BigInt(-5000), null, start, 2);
  });

  afterAll(async () => {
    await db.delete(users).where(sql`email LIKE ${"%" + FROZEN_TAG + "%"}`);
  });

  it("native mode: USD txs do NOT contribute to a COP budget (no cross-currency mixing)", async () => {
    const result = await getBudgetsOverview(
      frozenUserId,
      ym,
      { start, end },
      { displayCurrencyMode: "native", copPerUsd: LIVE_TRM },
    );
    const item = result.items.find((i) => i.categorySlug === "otros")!;
    expect(item.currency).toBe("COP");
    expect(BigInt(item.spentCents)).toBe(BigInt(0));
    expect(BigInt(item.amountCents)).toBe(BigInt(400_000_00));
    expect(item.hadFrozenTrmConversion).toBe(false);
  });

  it("all-cop mode: USD txs converted via FROZEN TRM (not live)", async () => {
    const result = await getBudgetsOverview(
      frozenUserId,
      ym,
      { start, end },
      { displayCurrencyMode: "all-cop", copPerUsd: LIVE_TRM },
    );
    const item = result.items.find((i) => i.categorySlug === "otros")!;
    expect(item.currency).toBe("COP");

    // tx1 (10000 cents USD * 3676.92) = 36,769,200 cents COP. tx2 (5000) lacks
    // TRM → falls back to USD, ends up in a separate bucket → does NOT enter
    // the COP total. Expected spent in COP = 36,769,200.
    expect(BigInt(item.spentCents)).toBe(BigInt(36_769_200));

    // Sanity: live TRM would have produced (10000 + 5000) * 4500 = 67,500,000.
    // Confirm the result is NOT that.
    expect(BigInt(item.spentCents)).not.toBe(BigInt(15000) * BigInt(LIVE_TRM));

    expect(item.hadFrozenTrmConversion).toBe(true);
    expect(item.missingTrmCount).toBe(1); // tx2 had no TRM
  });

  it("all-cop mode: budget amount converts via LIVE TRM (plans have no frozen rate)", async () => {
    // Budget is in COP, mode is all-cop → no conversion needed. Use a USD-budget
    // user to actually exercise the LIVE TRM conversion path.
    const usdUserId = await createUserFrozen(`${FROZEN_TAG}-usdbudget@example.com`);
    await createCopAccount(usdUserId, "usd-budget-acct");
    await db.insert(budgets).values({
      userId: usdUserId,
      categorySlug: "otros",
      amountCents: BigInt(500_00), // $500.00 USD
      currency: "USD",
      periodStart: periodStartIso,
      periodEnd: `${ym}-30`,
      active: true,
    });

    const result = await getBudgetsOverview(
      usdUserId,
      ym,
      { start, end },
      { displayCurrencyMode: "all-cop", copPerUsd: LIVE_TRM },
    );
    const item = result.items.find((i) => i.categorySlug === "otros")!;
    expect(item.currency).toBe("COP");

    // 500_00 USD cents * 4500 = 2,250,000 COP cents.
    expect(BigInt(item.amountCents)).toBe(BigInt(500_00) * BigInt(LIVE_TRM));
  });
});
