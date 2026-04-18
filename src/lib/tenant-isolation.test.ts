import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  budgets,
  classificationRules,
  counterparties,
  counterpartyAliases,
  ingestionLogs,
  insightsReports,
  recurringGaps,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import {
  getAccountStatuses,
  getCategoryBreakdown,
  getMonthlyFlow,
  getNetWorth,
  getTopExpenses,
} from "@/lib/dashboard/queries";
import { listAccountsDetailed } from "@/lib/accounts/queries";
import { getOpenGaps, getLinkCandidates } from "@/lib/recurring/gap-queries";
import { getUpcomingForMonth } from "@/lib/recurring/upcoming";
import { getSmsHealthHistory } from "@/lib/ingestion/sms-health";
import {
  countTotal,
  countUnclassified,
  listAccounts,
  listCounterparties,
  listTransactions,
} from "@/lib/transactions/queries";

// Integration test for #183 tenant isolation. Creates two parallel users with
// disjoint data and asserts every read path scoped to userA never returns
// userB's rows. Also verifies that INSERTs without user_id now fail (drop
// DEFAULT 1 migration applied).

const TAG = "ISOLATION_TEST";

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  return row.id;
}

async function createAccount(userId: number, name: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name,
      institution: TAG,
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createTransaction(
  userId: number,
  accountId: number,
  amountCents: bigint,
  occurredAt: Date,
  externalId: string,
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt,
      amountCents,
      currency: "COP",
      descriptionRaw: `${TAG} ${externalId}`,
      categorySlug: "otros",
      classificationMethod: "manual",
      source: "manual",
      externalId,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function createCounterparty(userId: number, displayName: string): Promise<number> {
  const [row] = await db
    .insert(counterparties)
    .values({ userId, displayName, type: "unknown" })
    .returning({ id: counterparties.id });
  return row.id;
}

async function createAlias(userId: number, counterpartyId: number, value: string): Promise<void> {
  await db.insert(counterpartyAliases).values({
    userId,
    counterpartyId,
    kind: "name",
    value,
  });
}

async function createRule(userId: number, pattern: string): Promise<void> {
  await db.insert(classificationRules).values({
    userId,
    pattern,
    categorySlug: "otros",
    priority: 1,
    active: true,
  });
}

async function createRecurring(userId: number, accountId: number, label: string): Promise<number> {
  const [row] = await db
    .insert(recurringTransactions)
    .values({
      userId,
      accountId,
      label,
      amountCents: BigInt(-100_000),
      currency: "COP",
      categorySlug: "otros",
      dayOfMonth: 15,
    })
    .returning({ id: recurringTransactions.id });
  return row.id;
}

async function createGap(userId: number, recurringId: number, yearMonth: string): Promise<number> {
  const [row] = await db
    .insert(recurringGaps)
    .values({ userId, recurringId, yearMonth })
    .returning({ id: recurringGaps.id });
  return row.id;
}

async function createBudget(userId: number): Promise<void> {
  await db.insert(budgets).values({
    userId,
    categorySlug: "otros",
    amountCents: BigInt(500_000),
    currency: "COP",
    periodStart: "2026-04-01",
    periodEnd: "2026-04-30",
    active: true,
  });
}

async function createIngestionLog(userId: number): Promise<void> {
  await db.insert(ingestionLogs).values({
    userId,
    source: "sms",
    status: "inserted",
    itemsReceived: 1,
    itemsInserted: 1,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
}

async function createInsight(userId: number, yearMonth: string): Promise<void> {
  await db.insert(insightsReports).values({
    userId,
    yearMonth,
    inputHash: "x".repeat(64),
    markdown: TAG,
    model: "test",
    inputTokens: 0,
    outputTokens: 0,
  });
}

let userA: number;
let userB: number;
let accountA: number;
let accountB: number;
let cpA: number;
let cpB: number;
let recurringA: number;
let recurringB: number;

async function cleanup() {
  // ON DELETE CASCADE on user_id handles downstream rows in tenant tables.
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

describe("#183 tenant isolation", () => {
  beforeAll(async () => {
    await cleanup();
    userA = await createUser(`${TAG}-A@test.local`);
    userB = await createUser(`${TAG}-B@test.local`);

    accountA = await createAccount(userA, `${TAG}-A acct`);
    accountB = await createAccount(userB, `${TAG}-B acct`);

    await createTransaction(userA, accountA, BigInt(-1000), new Date("2026-04-10"), `${TAG}-A-tx1`);
    await createTransaction(userA, accountA, BigInt(-2000), new Date("2026-04-12"), `${TAG}-A-tx2`);
    await createTransaction(userB, accountB, BigInt(-3000), new Date("2026-04-10"), `${TAG}-B-tx1`);

    cpA = await createCounterparty(userA, `${TAG}-A cp`);
    cpB = await createCounterparty(userB, `${TAG}-B cp`);
    await createAlias(userA, cpA, `${TAG}-A alias`);
    await createAlias(userB, cpB, `${TAG}-B alias`);

    await createRule(userA, `%${TAG}-A pattern%`);
    await createRule(userB, `%${TAG}-B pattern%`);

    recurringA = await createRecurring(userA, accountA, `${TAG}-A recurring`);
    recurringB = await createRecurring(userB, accountB, `${TAG}-B recurring`);

    await createGap(userA, recurringA, "2026-04");
    await createGap(userB, recurringB, "2026-04");

    await createBudget(userA);
    await createBudget(userB);

    await createIngestionLog(userA);
    await createIngestionLog(userB);

    await createInsight(userA, "2026-04");
    await createInsight(userB, "2026-04");
  });

  afterAll(async () => {
    await cleanup();
    await db.$client.end({ timeout: 1 });
  });

  // ---------------------------------------------------------------------------
  // Read-path isolation
  // ---------------------------------------------------------------------------

  describe("listTransactions", () => {
    it("returns only userA's transactions", async () => {
      const { rows } = await listTransactions(userA, {});
      const ours = rows.filter((r) => r.descriptionRaw.includes(TAG));
      expect(ours).toHaveLength(2);
      expect(ours.every((r) => r.descriptionRaw.includes(`${TAG}-A`))).toBe(true);
    });

    it("returns only userB's transactions", async () => {
      const { rows } = await listTransactions(userB, {});
      const ours = rows.filter((r) => r.descriptionRaw.includes(TAG));
      expect(ours).toHaveLength(1);
      expect(ours[0].descriptionRaw).toContain(`${TAG}-B`);
    });
  });

  it("countTotal and countUnclassified are scoped per user", async () => {
    const totalA = await countTotal(userA, {});
    const totalB = await countTotal(userB, {});
    const rows = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = ${userA}
    `);
    expect(totalA).toBe(rows[0].c);
    expect(totalB).toBeGreaterThan(0);
    expect(totalA).not.toBe(totalB);
    // userA has no unclassified fixtures; userB has none either. Both just
    // need to not read each other's rows — the SQL COUNT with no user predicate
    // would have yielded A+B.
    const unclassifiedA = await countUnclassified(userA);
    const unclassifiedB = await countUnclassified(userB);
    expect(unclassifiedA).toBe(0);
    expect(unclassifiedB).toBe(0);
  });

  it("listAccounts + listAccountsDetailed are scoped per user", async () => {
    const accsA = await listAccounts(userA);
    const accsB = await listAccounts(userB);
    expect(accsA.map((a) => a.id)).toEqual([accountA]);
    expect(accsB.map((a) => a.id)).toEqual([accountB]);

    const detailedA = await listAccountsDetailed(userA);
    expect(detailedA.every((a) => a.institution === TAG)).toBe(true);
    expect(detailedA).toHaveLength(1);
  });

  it("listCounterparties is scoped per user", async () => {
    const cpsA = await listCounterparties(userA);
    const cpsB = await listCounterparties(userB);
    const ourA = cpsA.filter((c) => c.displayName.includes(TAG));
    const ourB = cpsB.filter((c) => c.displayName.includes(TAG));
    expect(ourA.map((c) => c.id)).toEqual([cpA]);
    expect(ourB.map((c) => c.id)).toEqual([cpB]);
  });

  it("dashboard queries are scoped per user", async () => {
    const [nwA, nwB] = await Promise.all([getNetWorth(userA, 4000), getNetWorth(userB, 4000)]);
    // Distinct values because userA and userB touch disjoint accounts (all are
    // empty; balances stay at 0 but the SQL paths are exercised).
    expect(nwA.totalCopCents).toBe(BigInt(0));
    expect(nwB.totalCopCents).toBe(BigInt(0));

    const statusesA = await getAccountStatuses(userA);
    expect(statusesA).toHaveLength(1);
    expect(statusesA[0].id).toBe(accountA);

    const flowA = await getMonthlyFlow(userA, 4000, new Date("2026-04-15"));
    // Sum of -1000 + -2000 = -3000 for userA, so expense=3000.
    expect(flowA.expenseCopCents).toBe(BigInt(3000));

    const flowB = await getMonthlyFlow(userB, 4000, new Date("2026-04-15"));
    expect(flowB.expenseCopCents).toBe(BigInt(3000));

    const catA = await getCategoryBreakdown(userA, 4000, new Date("2026-04-15"));
    expect(catA.every((c) => c.amountCopCents >= BigInt(0))).toBe(true);

    const topA = await getTopExpenses(userA, 4000, new Date("2026-04-15"), 10);
    expect(topA.every((t) => t.descriptionRaw.includes(`${TAG}-A`))).toBe(true);
  });

  it("classifyByRule only sees the calling user's rules", async () => {
    const hitA = await classifyByRule(userA, { descriptionRaw: `${TAG}-A pattern match` });
    expect(hitA).not.toBeNull();

    // userB has a different pattern; userA's scope must not match it.
    const crossMiss = await classifyByRule(userA, { descriptionRaw: `${TAG}-B pattern match` });
    expect(crossMiss).toBeNull();

    const hitB = await classifyByRule(userB, { descriptionRaw: `${TAG}-B pattern match` });
    expect(hitB).not.toBeNull();
  });

  it("getOpenGaps + getLinkCandidates are scoped per user", async () => {
    const gapsA = await getOpenGaps(userA);
    const gapsB = await getOpenGaps(userB);
    expect(gapsA.every((g) => g.label.includes(`${TAG}-A`))).toBe(true);
    expect(gapsB.every((g) => g.label.includes(`${TAG}-B`))).toBe(true);

    // Cross-tenant gapId lookup must return empty (even though the gap row
    // exists for userB, userA's scope hides it).
    const gapBId = gapsB[0]!.gapId;
    const crossCandidates = await getLinkCandidates(userA, gapBId);
    expect(crossCandidates).toEqual([]);
  });

  it("getUpcomingForMonth is scoped per user", async () => {
    const upA = await getUpcomingForMonth({ userId: userA, year: 2026, month: 4 });
    const upB = await getUpcomingForMonth({ userId: userB, year: 2026, month: 4 });
    expect(upA.every((u) => u.label.includes(`${TAG}-A`))).toBe(true);
    expect(upB.every((u) => u.label.includes(`${TAG}-B`))).toBe(true);
  });

  it("getSmsHealthHistory is scoped per user", async () => {
    const historyA = await getSmsHealthHistory(userA, 30);
    const historyB = await getSmsHealthHistory(userB, 30);
    // Each user inserted exactly one 'inserted' sms log.
    const countA = historyA.reduce((s, d) => s + d.inserted, 0);
    const countB = historyB.reduce((s, d) => s + d.inserted, 0);
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // DEFAULT 1 is gone — raw INSERTs without user_id must fail now.
  // Verifies the #183 PR 3b migration.
  // ---------------------------------------------------------------------------

  it("INSERT into accounts without user_id fails (DEFAULT 1 dropped)", async () => {
    await expect(
      db.execute(
        sql`INSERT INTO accounts (name, institution, type, currency) VALUES (${TAG + " fail"}, ${TAG}, 'savings', 'COP')`,
      ),
    ).rejects.toThrow();
  });

  it("INSERT into transactions without user_id fails (DEFAULT 1 dropped)", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO transactions (account_id, occurred_at, amount_cents, currency, description_raw, classification_method, source)
        VALUES (${accountA}, now(), 0, 'COP', ${TAG + " fail"}, 'manual', 'manual')
      `),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Counterparty + alias uniqueness is now per-user
  // (classification_rules unique + counterparty_aliases unique both landed in
  //  PR 2 / #183). Same (kind, value) across different users must coexist.
  // ---------------------------------------------------------------------------

  it("two users can hold the same counterparty alias (user_id, kind, value)", async () => {
    const [cpA2] = await db
      .insert(counterparties)
      .values({ userId: userA, displayName: `${TAG}-A cp2`, type: "unknown" })
      .returning({ id: counterparties.id });
    const [cpB2] = await db
      .insert(counterparties)
      .values({ userId: userB, displayName: `${TAG}-B cp2`, type: "unknown" })
      .returning({ id: counterparties.id });

    const sharedValue = `${TAG}-shared`;
    await db
      .insert(counterpartyAliases)
      .values({ userId: userA, counterpartyId: cpA2.id, kind: "name", value: sharedValue });
    await db
      .insert(counterpartyAliases)
      .values({ userId: userB, counterpartyId: cpB2.id, kind: "name", value: sharedValue });

    const rowsA = await db
      .select({ id: counterpartyAliases.id })
      .from(counterpartyAliases)
      .where(
        and(eq(counterpartyAliases.userId, userA), eq(counterpartyAliases.value, sharedValue)),
      );
    const rowsB = await db
      .select({ id: counterpartyAliases.id })
      .from(counterpartyAliases)
      .where(
        and(eq(counterpartyAliases.userId, userB), eq(counterpartyAliases.value, sharedValue)),
      );
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
  });
});
