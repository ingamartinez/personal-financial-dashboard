import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  budgets,
  categories,
  classificationRules,
  counterparties,
  emailReceipts,
  gmailConnections,
  ingestionLogs,
  recurringTransactions,
  transactions,
  userSnapshots,
  users,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";
import { restoreSnapshotForUser } from "@/lib/snapshots/create";
import { buildPreResetName, resetUserData } from "./reset";

// Integration tests for #472. Verifies four things:
//   1. Wipe scope — transactional tables are emptied, config survives.
//   2. Auto-snapshot — a `pre-reset-*` row lands in user_snapshots BEFORE
//      the wipe so the user can roll back.
//   3. Gmail cursor — last_pull_history_id is nulled out (config is kept,
//      but ingestion state is treated as transactional).
//   4. Tenant isolation — resetUserData for user A does not touch user B's
//      data or snapshots.

const TAG = "RESET_TEST";

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  await copyRuleSeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number, name: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({ userId, name, institution: TAG, type: "savings", currency: "COP" })
    .returning({ id: accounts.id });
  return row.id;
}

async function createTransaction(
  userId: number,
  accountId: number,
  amountCents: bigint,
  externalId: string,
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-10"),
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

async function createGmailConnection(userId: number): Promise<number> {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}-${userId}@example.com`,
      accessTokenEnc: "enc",
      refreshTokenEnc: "enc",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      lastPullAt: new Date("2026-04-01T00:00:00Z"),
      lastPullHistoryId: "hist-reset-123",
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

async function createEmailReceipt(
  userId: number,
  gmailConnectionId: number,
  msgId: string,
): Promise<void> {
  await db.insert(emailReceipts).values({
    userId,
    gmailConnectionId,
    gmailMsgId: msgId,
    gateway: "mercado_pago",
    rawHtml: "<html />",
    matchStatus: "matched",
  });
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

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function countWhere(userId: number, tableSql: ReturnType<typeof sql.raw>): Promise<number> {
  const rows = await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM ${tableSql} WHERE user_id = ${userId}
  `);
  return rows[0].c;
}

describe("#472 reset user transactional data", () => {
  let userA: number;
  let userB: number;
  let accountA: number;
  let accountB: number;
  let connA: number;

  beforeAll(async () => {
    await cleanup();
    userA = await createUser(`${TAG}-A@test.local`);
    userB = await createUser(`${TAG}-B@test.local`);
    accountA = await createAccount(userA, `${TAG}-A acct`);
    accountB = await createAccount(userB, `${TAG}-B acct`);
    connA = await createGmailConnection(userA);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    // Nuke snapshots + transactional between tests so we always start from
    // the same fixture state.
    await db.delete(userSnapshots);
    await db.delete(transactions).where(eq(transactions.userId, userA));
    await db.delete(transactions).where(eq(transactions.userId, userB));
    await db.delete(emailReceipts).where(eq(emailReceipts.userId, userA));
    await db.delete(emailReceipts).where(eq(emailReceipts.userId, userB));
    await db.delete(ingestionLogs).where(eq(ingestionLogs.userId, userA));
    await db.delete(ingestionLogs).where(eq(ingestionLogs.userId, userB));
    await db.delete(budgets).where(eq(budgets.userId, userA));
    await db.delete(budgets).where(eq(budgets.userId, userB));
    await db.delete(recurringTransactions).where(eq(recurringTransactions.userId, userA));
    await db.delete(recurringTransactions).where(eq(recurringTransactions.userId, userB));
    // Keep at least one transaction + log for each user so reset has
    // something to delete.
    await createTransaction(userA, accountA, BigInt(-1000), `${TAG}-A-fixture`);
    await createTransaction(userB, accountB, BigInt(-2000), `${TAG}-B-fixture`);
    await createEmailReceipt(userA, connA, `${TAG}-A-msg`);
    await createBudget(userA);
    await createIngestionLog(userA);
    await db
      .update(gmailConnections)
      .set({
        lastPullAt: new Date("2026-04-01T00:00:00Z"),
        lastPullHistoryId: "hist-reset-123",
      })
      .where(eq(gmailConnections.id, connA));
  });

  describe("wipe scope", () => {
    it("clears transactions, email_receipts, ingestion_logs for the caller", async () => {
      expect(await countWhere(userA, sql.raw("transactions"))).toBeGreaterThan(0);
      expect(await countWhere(userA, sql.raw("email_receipts"))).toBeGreaterThan(0);
      expect(await countWhere(userA, sql.raw("ingestion_logs"))).toBeGreaterThan(0);

      await resetUserData({ userId: userA });

      expect(await countWhere(userA, sql.raw("transactions"))).toBe(0);
      expect(await countWhere(userA, sql.raw("email_receipts"))).toBe(0);
      expect(await countWhere(userA, sql.raw("ingestion_logs"))).toBe(0);
    });

    it("preserves config (accounts, categories, rules, budgets, counterparties, recurring_transactions)", async () => {
      await db.insert(counterparties).values({
        userId: userA,
        displayName: `${TAG}-cp-preserve`,
        type: "unknown",
      });
      // #475: recurring_transactions is the user's forecast definition (config).
      // recurring_gaps + skipped_consolidation_cycles are the derived state
      // that DOES get wiped — but the parent definition must survive so the
      // forecast keeps firing predictions after a reset.
      await db.insert(recurringTransactions).values({
        userId: userA,
        accountId: accountA,
        label: `${TAG}-recurring-preserve`,
        amountCents: BigInt(-1_500_000),
        currency: "COP",
        categorySlug: "otros",
        dayOfMonth: 15,
      });

      const accountsBefore = await countWhere(userA, sql.raw("accounts"));
      const [{ c: catsBefore }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM categories WHERE user_id = ${userA}
      `);
      const [{ c: rulesBefore }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM classification_rules WHERE user_id = ${userA}
      `);
      const budgetsBefore = await countWhere(userA, sql.raw("budgets"));
      const cpsBefore = await countWhere(userA, sql.raw("counterparties"));
      const recurringBefore = await countWhere(userA, sql.raw("recurring_transactions"));
      expect(recurringBefore).toBeGreaterThan(0);

      await resetUserData({ userId: userA });

      expect(await countWhere(userA, sql.raw("accounts"))).toBe(accountsBefore);
      const [{ c: catsAfter }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM categories WHERE user_id = ${userA}
      `);
      const [{ c: rulesAfter }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM classification_rules WHERE user_id = ${userA}
      `);
      expect(catsAfter).toBe(catsBefore);
      expect(rulesAfter).toBe(rulesBefore);
      expect(await countWhere(userA, sql.raw("budgets"))).toBe(budgetsBefore);
      expect(await countWhere(userA, sql.raw("counterparties"))).toBe(cpsBefore);
      expect(await countWhere(userA, sql.raw("recurring_transactions"))).toBe(recurringBefore);
    });

    it("preserves the Gmail ingestion cursor and connection on reset", async () => {
      // #498 — reset must NOT null the cursor. Nulling caused unintended mass
      // re-ingestion on the next cron tick after a data reset.
      await resetUserData({ userId: userA });

      const [conn] = await db
        .select({
          id: gmailConnections.id,
          accessTokenEnc: gmailConnections.accessTokenEnc,
          refreshTokenEnc: gmailConnections.refreshTokenEnc,
          lastPullAt: gmailConnections.lastPullAt,
          lastPullHistoryId: gmailConnections.lastPullHistoryId,
        })
        .from(gmailConnections)
        .where(eq(gmailConnections.id, connA));

      // Connection still exists, tokens intact.
      expect(conn.id).toBe(connA);
      expect(conn.accessTokenEnc).toBe("enc");
      expect(conn.refreshTokenEnc).toBe("enc");
      // Cursor preserved — matches the values seeded in beforeEach.
      expect(conn.lastPullAt).toEqual(new Date("2026-04-01T00:00:00Z"));
      expect(conn.lastPullHistoryId).toBe("hist-reset-123");
    });
  });

  describe("auto-snapshot", () => {
    it("creates exactly one pre-reset snapshot with the expected name format", async () => {
      const { snapshot } = await resetUserData({ userId: userA });

      expect(snapshot.name).toMatch(/^pre-reset-\d{4}-\d{2}-\d{2}-\d{4}$/);

      const rows = await db
        .select({ id: userSnapshots.id, name: userSnapshots.name })
        .from(userSnapshots)
        .where(eq(userSnapshots.userId, userA));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(snapshot.id);
    });

    it("builds a deterministic name from the given Date (format sanity)", () => {
      const fixed = new Date("2026-04-24T09:05:00Z");
      const name = buildPreResetName(fixed);
      expect(name).toMatch(/^pre-reset-\d{4}-\d{2}-\d{2}-\d{4}$/);
    });

    it("restoring the auto-snapshot recovers the pre-reset state", async () => {
      const tx1Id = await createTransaction(userA, accountA, BigInt(-111), `${TAG}-A-extra-1`);
      const tx2Id = await createTransaction(userA, accountA, BigInt(-222), `${TAG}-A-extra-2`);

      const preCount = await countWhere(userA, sql.raw("transactions"));
      expect(preCount).toBeGreaterThanOrEqual(3);

      const { snapshot } = await resetUserData({ userId: userA });
      expect(await countWhere(userA, sql.raw("transactions"))).toBe(0);

      const result = await restoreSnapshotForUser({
        userId: userA,
        snapshotId: snapshot.id,
      });
      expect(result.ok).toBe(true);

      expect(await countWhere(userA, sql.raw("transactions"))).toBe(preCount);
      const restored = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.userId, userA));
      const ids = new Set(restored.map((r) => r.id));
      expect(ids.has(tx1Id)).toBe(true);
      expect(ids.has(tx2Id)).toBe(true);
    });
  });

  describe("tenant isolation", () => {
    it("does not touch userB's transactional data or snapshots", async () => {
      // Make sure userB has at least one snapshot already.
      await db.insert(userSnapshots).values({
        userId: userB,
        name: "userB-preexisting",
        schemaVersion: "noop-for-test",
        payload: { version: 1, tables: {}, gmailCursors: [] } as object,
        payloadBytes: BigInt(42),
      });

      const txsBBefore = await countWhere(userB, sql.raw("transactions"));
      const snapsBBefore = await db
        .select({ id: userSnapshots.id })
        .from(userSnapshots)
        .where(eq(userSnapshots.userId, userB));

      await resetUserData({ userId: userA });

      expect(await countWhere(userB, sql.raw("transactions"))).toBe(txsBBefore);
      const snapsBAfter = await db
        .select({ id: userSnapshots.id })
        .from(userSnapshots)
        .where(eq(userSnapshots.userId, userB));
      expect(snapsBAfter.map((s) => s.id).sort()).toEqual(snapsBBefore.map((s) => s.id).sort());

      // Sanity: userA IS wiped.
      expect(await countWhere(userA, sql.raw("transactions"))).toBe(0);
    });
  });

  describe("atomicity", () => {
    // The auto-snapshot and the wipe live in one transaction. Hard to
    // simulate a mid-wipe failure without mocking drizzle internals, so
    // we verify the happy-path invariant: when reset returns, the
    // snapshot row exists AND transactional data is empty — both true
    // or both untouched, never a half-state.
    it("after a successful reset, snapshot exists and tx data is empty", async () => {
      const { snapshot } = await resetUserData({ userId: userA });

      const [snap] = await db
        .select({ id: userSnapshots.id })
        .from(userSnapshots)
        .where(and(eq(userSnapshots.id, snapshot.id), eq(userSnapshots.userId, userA)));
      expect(snap.id).toBe(snapshot.id);
      expect(await countWhere(userA, sql.raw("transactions"))).toBe(0);
    });
  });

  // Narrow sanity — ensures the test helpers themselves hit the right
  // schema objects; a stale import here would silently skip coverage.
  it("fixture references exist", () => {
    expect(categories).toBeDefined();
    expect(classificationRules).toBeDefined();
  });
});
