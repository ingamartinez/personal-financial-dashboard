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
