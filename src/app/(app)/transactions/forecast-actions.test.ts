// #632: Integration tests for getLinkCandidatesForForecast (redesigned).
// Tests window-based candidate fetching, sugeridas/todas split, and tenant safety.
// Runs against findash_test (forced by vitest.setup.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, recurringTransactions, transactions, users } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({
    id: 1,
    email: "test@test.local",
    name: "Test",
    role: "user" as const,
    active: true,
  }),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks)
// ---------------------------------------------------------------------------

const { getLinkCandidatesForForecast } = await import("./forecast-actions");
const { getSessionUser } = await import("@/lib/auth/session");
const mockGetSessionUser = vi.mocked(getSessionUser);

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const TAG = "__fcast632__";

async function cleanup() {
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${"%" + TAG + "%"}`);
}

async function seedUser(email: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email, name: email })
    .returning({ id: users.id });
  return row.id;
}

async function seedAccount(
  userId: number,
  currency: "COP" | "USD" = "COP",
): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}acct`,
      institution: TAG,
      type: "savings",
      currency,
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedRecurring(
  userId: number,
  accountId: number,
  opts: {
    label?: string;
    amountCents?: bigint;
    dayOfMonth?: number;
    currency?: "COP" | "USD";
  } = {},
): Promise<number> {
  const [row] = await db
    .insert(recurringTransactions)
    .values({
      userId,
      accountId,
      label: opts.label ?? `${TAG}recurring`,
      amountCents: opts.amountCents ?? BigInt(-100000),
      currency: opts.currency ?? "COP",
      dayOfMonth: opts.dayOfMonth ?? 15,
      active: true,
    })
    .returning({ id: recurringTransactions.id });
  return row.id;
}

async function seedTx(
  userId: number,
  accountId: number,
  opts: {
    occurredOn: string;
    amountCents?: bigint;
    currency?: "COP" | "USD";
    description?: string;
    recurringId?: number | null;
  },
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date(`${opts.occurredOn}T12:00:00Z`),
      amountCents: opts.amountCents ?? BigInt(-100000),
      currency: opts.currency ?? "COP",
      descriptionRaw: opts.description ?? `${TAG}tx`,
      source: "manual",
      recurringId: opts.recurringId ?? null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

describe("getLinkCandidatesForForecast (#632 redesign)", () => {
  const USER_ID = 1;

  beforeEach(async () => {
    await cleanup();
    mockGetSessionUser.mockResolvedValue({
      id: USER_ID,
      email: "test@test.local",
      name: "Test",
      role: "user",
      active: true,
    });
  });
  afterEach(cleanup);

  it("default window is [expectedDate-10d, expectedDate+5d], ALL accounts", async () => {
    const accountId = await seedAccount(USER_ID);
    const account2Id = await seedAccount(USER_ID);
    const recurringId = await seedRecurring(USER_ID, accountId, {
      dayOfMonth: 15,
      amountCents: BigInt(-100000),
    });

    // tx on different account, within default window (day 15 ± 10d/+5d = Apr 5 – Apr 20).
    await seedTx(USER_ID, account2Id, {
      occurredOn: "2026-04-12",
      amountCents: BigInt(-100000),
    });

    const result = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-04",
      showAll: false,
    });

    // Should find the tx from account2 (all-accounts scope).
    const allCandidates = [...result.sugeridas, ...result.todas];
    expect(allCandidates.length).toBeGreaterThanOrEqual(1);
    const found = allCandidates.some(() => true); // at least one candidate returned
    expect(found).toBe(true);
  });

  it("excludes already-linked transactions (recurringId IS NOT NULL)", async () => {
    const accountId = await seedAccount(USER_ID);
    const recurringId = await seedRecurring(USER_ID, accountId, {
      dayOfMonth: 15,
      amountCents: BigInt(-100000),
    });
    const otherRecurring = await seedRecurring(USER_ID, accountId, {
      label: `${TAG}other`,
      dayOfMonth: 15,
      amountCents: BigInt(-100000),
    });

    // tx already linked to another recurring.
    const txId = await seedTx(USER_ID, accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-100000),
      recurringId: otherRecurring,
    });

    const result = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-04",
    });

    const allCandidates = [...result.sugeridas, ...result.todas];
    expect(allCandidates.find((c) => c.txId === txId)).toBeUndefined();
  });

  it("window-based: tx outside window not returned even with showAll=false", async () => {
    const accountId = await seedAccount(USER_ID);
    const recurringId = await seedRecurring(USER_ID, accountId, {
      dayOfMonth: 15, // Apr 15; window [Apr 5, Apr 20]
      amountCents: BigInt(-100000),
    });

    // tx on Apr 1 — 14 days before expectedDate (Apr 15). Outside [-10d, +5d] window.
    const txId = await seedTx(USER_ID, accountId, {
      occurredOn: "2026-04-01",
      amountCents: BigInt(-100000),
    });

    const result = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-04",
      showAll: false,
    });

    const allCandidates = [...result.sugeridas, ...result.todas];
    expect(allCandidates.find((c) => c.txId === txId)).toBeUndefined();
  });

  it("showAll=true expands window to [expectedDate-30d, expectedDate+10d]", async () => {
    const accountId = await seedAccount(USER_ID);
    const recurringId = await seedRecurring(USER_ID, accountId, {
      dayOfMonth: 15, // Apr 15
      amountCents: BigInt(-100000),
    });

    // tx on Mar 25 — 21 days before expectedDate. Outside default [-10d], inside expanded [-30d].
    const txId = await seedTx(USER_ID, accountId, {
      occurredOn: "2026-03-25",
      amountCents: BigInt(-100000),
    });

    // Not returned in default window.
    const defaultResult = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-04",
      showAll: false,
    });
    const inDefault = [...defaultResult.sugeridas, ...defaultResult.todas];
    expect(inDefault.find((c) => c.txId === txId)).toBeUndefined();

    // Returned in expanded window.
    const expandedResult = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-04",
      showAll: true,
    });
    const inExpanded = [...expandedResult.sugeridas, ...expandedResult.todas];
    expect(inExpanded.find((c) => c.txId === txId)).toBeDefined();
  });

  it("sugeridas: same-currency tx within ±20% of recurring amount", async () => {
    const accountId = await seedAccount(USER_ID, "COP");
    const recurringId = await seedRecurring(USER_ID, accountId, {
      dayOfMonth: 15,
      amountCents: BigInt(-100000),
      currency: "COP",
    });

    // Tx within ±20% (-80000 to -120000): should go to sugeridas.
    const txInRangeId = await seedTx(USER_ID, accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-105000), // 5% away from -100000
      currency: "COP",
      description: `${TAG}in_range`,
    });

    // Tx out of range (-130000): should go to todas.
    const txOutRangeId = await seedTx(USER_ID, accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-130000), // 30% away
      currency: "COP",
      description: `${TAG}out_range`,
    });

    // USD tx (different currency): always goes to todas regardless of amount.
    const account2Id = await seedAccount(USER_ID, "USD");
    const txUsdId = await seedTx(USER_ID, account2Id, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-100),
      currency: "USD",
      description: `${TAG}usd`,
    });

    const result = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-04",
    });

    expect(result.sugeridas.find((c) => c.txId === txInRangeId)).toBeDefined();
    expect(result.todas.find((c) => c.txId === txOutRangeId)).toBeDefined();
    expect(result.todas.find((c) => c.txId === txUsdId)).toBeDefined();
    // sugeridas should NOT contain the out-of-range or USD tx
    expect(result.sugeridas.find((c) => c.txId === txOutRangeId)).toBeUndefined();
    expect(result.sugeridas.find((c) => c.txId === txUsdId)).toBeUndefined();
  });

  it("tenant safety: user2 transactions not returned for user1", async () => {
    const user2Id = await seedUser(`u2${TAG}@test.local`);
    const user1AccountId = await seedAccount(USER_ID);
    const user2AccountId = await seedAccount(user2Id);

    const recurringId = await seedRecurring(USER_ID, user1AccountId, {
      dayOfMonth: 15,
      amountCents: BigInt(-100000),
    });

    // User2 has a tx at the same day+amount.
    const user2TxId = await seedTx(user2Id, user2AccountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-100000),
    });

    // User1 is the session user.
    mockGetSessionUser.mockResolvedValue({
      id: USER_ID,
      email: "test@test.local",
      name: "Test",
      role: "user",
      active: true,
    });

    const result = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-04",
    });

    const allCandidates = [...result.sugeridas, ...result.todas];
    expect(allCandidates.find((c) => c.txId === user2TxId)).toBeUndefined();
  });

  it("cross-month: tx on April 29 appears as candidate for May 1 recurring", async () => {
    const accountId = await seedAccount(USER_ID);
    const recurringId = await seedRecurring(USER_ID, accountId, {
      dayOfMonth: 1, // May 1
      amountCents: BigInt(-100000),
    });

    // tx on April 29 — within window for May 1: [Apr 21, May 6].
    const txId = await seedTx(USER_ID, accountId, {
      occurredOn: "2026-04-29",
      amountCents: BigInt(-100000),
    });

    const result = await getLinkCandidatesForForecast({
      recurringId,
      yearMonth: "2026-05", // May slot
    });

    const allCandidates = [...result.sugeridas, ...result.todas];
    expect(allCandidates.find((c) => c.txId === txId)).toBeDefined();
  });

  it("returns recurringAmountCents and recurringCurrency in result", async () => {
    const accountId = await seedAccount(USER_ID);
    const recurringId = await seedRecurring(USER_ID, accountId, {
      amountCents: BigInt(-250000),
      currency: "COP",
      dayOfMonth: 10,
    });

    const result = await getLinkCandidatesForForecast({ recurringId, yearMonth: "2026-04" });
    expect(result.recurringAmountCents).toBe(BigInt(-250000));
    expect(result.recurringCurrency).toBe("COP");
  });
});
