import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  emailReceipts,
  gmailConnections,
  transactions,
  userSnapshots,
  users,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";
import { createSnapshotForUser, deleteSnapshotForUser, restoreSnapshotForUser } from "./create";
import { dumpUserPayload } from "./payload";

// Integration tests for #471. Verifies three things:
//   1. Roundtrip — snapshot → wipe → restore puts data back exactly.
//   2. Tenant isolation — user A's snapshot cannot read/write user B's rows.
//   3. Schema version guard — restore across a simulated version mismatch fails.
// Config tables (accounts, categories, rules) MUST survive both wipe and
// restore: they're never included in the payload.

const TAG = "SNAPSHOT_TEST";

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  await copyRuleSeedsToUser(row.id);
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
      lastPullHistoryId: "hist-123",
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

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function countTransactions(userId: number): Promise<number> {
  const rows = await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = ${userId}
  `);
  return rows[0].c;
}

async function countAccounts(userId: number): Promise<number> {
  const rows = await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM accounts WHERE user_id = ${userId}
  `);
  return rows[0].c;
}

describe("#471 user snapshots", () => {
  let userA: number;
  let userB: number;
  let accountA: number;
  let connA: number;

  beforeAll(async () => {
    await cleanup();
    userA = await createUser(`${TAG}-A@test.local`);
    userB = await createUser(`${TAG}-B@test.local`);
    accountA = await createAccount(userA, `${TAG}-A acct`);
    await createAccount(userB, `${TAG}-B acct`);
    connA = await createGmailConnection(userA);
  });

  afterAll(async () => {
    await cleanup();
  });

  // Each test gets a clean transactional slate so ordering doesn't matter.
  beforeEach(async () => {
    await db.delete(userSnapshots).where(eq(userSnapshots.userId, userA));
    await db.delete(userSnapshots).where(eq(userSnapshots.userId, userB));
    await db.delete(transactions).where(eq(transactions.userId, userA));
    await db.delete(transactions).where(eq(transactions.userId, userB));
    await db.delete(emailReceipts).where(eq(emailReceipts.userId, userA));
    await db.delete(emailReceipts).where(eq(emailReceipts.userId, userB));
    await db
      .update(gmailConnections)
      .set({ lastPullAt: new Date("2026-04-01T00:00:00Z"), lastPullHistoryId: "hist-123" })
      .where(eq(gmailConnections.userId, userA));
  });

  describe("roundtrip", () => {
    it("restores transactions + email receipts + gmail cursor to pre-wipe state", async () => {
      const tx1 = await createTransaction(userA, accountA, BigInt(-1000), `${TAG}-tx1`);
      const tx2 = await createTransaction(userA, accountA, BigInt(-2000), `${TAG}-tx2`);
      await createEmailReceipt(userA, connA, `${TAG}-msg-1`);

      const snap = await createSnapshotForUser({ userId: userA, name: "t-roundtrip" });
      expect(snap.payloadBytes).toBeGreaterThan(BigInt(0));

      // Destructive change: wipe all txs, null cursor, delete receipts.
      await db.delete(transactions).where(eq(transactions.userId, userA));
      await db.delete(emailReceipts).where(eq(emailReceipts.userId, userA));
      await db
        .update(gmailConnections)
        .set({ lastPullAt: null, lastPullHistoryId: null })
        .where(eq(gmailConnections.id, connA));
      expect(await countTransactions(userA)).toBe(0);

      const result = await restoreSnapshotForUser({
        userId: userA,
        snapshotId: snap.id,
      });
      expect(result.ok).toBe(true);

      const restored = await db
        .select({ id: transactions.id, externalId: transactions.externalId })
        .from(transactions)
        .where(eq(transactions.userId, userA))
        .orderBy(transactions.id);
      expect(restored.map((r) => r.id)).toEqual([tx1, tx2]);

      const receipts = await db
        .select({ id: emailReceipts.id })
        .from(emailReceipts)
        .where(eq(emailReceipts.userId, userA));
      expect(receipts).toHaveLength(1);

      const [conn] = await db
        .select({ lastPullHistoryId: gmailConnections.lastPullHistoryId })
        .from(gmailConnections)
        .where(eq(gmailConnections.id, connA));
      expect(conn.lastPullHistoryId).toBe("hist-123");
    });

    it("advances the id sequence past restored rows", async () => {
      await createTransaction(userA, accountA, BigInt(-500), `${TAG}-seq-1`);
      const snap = await createSnapshotForUser({ userId: userA, name: "t-seq" });
      await db.delete(transactions).where(eq(transactions.userId, userA));
      await restoreSnapshotForUser({ userId: userA, snapshotId: snap.id });

      // A subsequent DEFAULT insert must not collide with restored ids.
      const nextId = await createTransaction(userA, accountA, BigInt(-999), `${TAG}-seq-next`);
      const all = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.userId, userA))
        .orderBy(transactions.id);
      expect(all.map((r) => r.id)).toContain(nextId);
      expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    });

    it("leaves config (accounts + categories + rules) intact through a wipe+restore cycle", async () => {
      await createTransaction(userA, accountA, BigInt(-100), `${TAG}-cfg`);
      const snap = await createSnapshotForUser({ userId: userA, name: "t-cfg" });

      const accountsBefore = await countAccounts(userA);
      const [{ c: catsBefore }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM categories WHERE user_id = ${userA}
      `);
      const [{ c: rulesBefore }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM classification_rules WHERE user_id = ${userA}
      `);

      await db.delete(transactions).where(eq(transactions.userId, userA));
      await restoreSnapshotForUser({ userId: userA, snapshotId: snap.id });

      expect(await countAccounts(userA)).toBe(accountsBefore);
      const [{ c: catsAfter }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM categories WHERE user_id = ${userA}
      `);
      const [{ c: rulesAfter }] = await db.execute<{ c: number }>(sql`
        SELECT COUNT(*)::int AS c FROM classification_rules WHERE user_id = ${userA}
      `);
      expect(catsAfter).toBe(catsBefore);
      expect(rulesAfter).toBe(rulesBefore);
    });
  });

  describe("tenant isolation", () => {
    it("dumpUserPayload for userA does not include userB's rows", async () => {
      const [accountBId] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.userId, userB));
      await createTransaction(userA, accountA, BigInt(-111), `${TAG}-A-only`);
      await createTransaction(userB, accountBId.id, BigInt(-222), `${TAG}-B-only`);

      const payload = await dumpUserPayload(userA);
      const descs = (payload.tables.transactions as Array<{ description_raw: string }>).map(
        (r) => r.description_raw,
      );
      expect(descs.some((d) => d.includes(`${TAG}-A-only`))).toBe(true);
      expect(descs.some((d) => d.includes(`${TAG}-B-only`))).toBe(false);
    });

    it("restoreSnapshotForUser cannot be called with a snapshot owned by another user", async () => {
      await createTransaction(userA, accountA, BigInt(-333), `${TAG}-A-iso`);
      const snap = await createSnapshotForUser({ userId: userA, name: "t-iso" });

      const result = await restoreSnapshotForUser({
        userId: userB,
        snapshotId: snap.id,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not_found");
      }
    });

    it("deleteSnapshotForUser cannot delete another user's snapshot", async () => {
      const snap = await createSnapshotForUser({ userId: userA, name: "t-iso-delete" });

      const ok = await deleteSnapshotForUser({ userId: userB, snapshotId: snap.id });
      expect(ok).toBe(false);

      const remaining = await db
        .select({ id: userSnapshots.id })
        .from(userSnapshots)
        .where(and(eq(userSnapshots.id, snap.id), eq(userSnapshots.userId, userA)));
      expect(remaining).toHaveLength(1);
    });

    it("restoreSnapshotForUser does not wipe userB's data", async () => {
      // userB has a transaction that must survive userA's restore operation.
      const [accountBId] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.userId, userB));
      await createTransaction(userB, accountBId.id, BigInt(-7777), `${TAG}-B-protected`);

      await createTransaction(userA, accountA, BigInt(-1), `${TAG}-A-rx`);
      const snap = await createSnapshotForUser({ userId: userA, name: "t-noleak" });
      await db.delete(transactions).where(eq(transactions.userId, userA));

      const before = await countTransactions(userB);
      await restoreSnapshotForUser({ userId: userA, snapshotId: snap.id });
      const after = await countTransactions(userB);

      expect(after).toBe(before);
    });
  });

  describe("schema version guard", () => {
    it("rejects restore when the snapshot's schema_version does not match current", async () => {
      await createTransaction(userA, accountA, BigInt(-1), `${TAG}-ver`);
      const snap = await createSnapshotForUser({ userId: userA, name: "t-ver" });

      // Simulate a schema drift: overwrite the stored version with a bogus
      // value. In real life this would be the result of a DB migration
      // landing between snapshot creation and restore.
      await db
        .update(userSnapshots)
        .set({ schemaVersion: "deadbeef-not-a-real-hash" })
        .where(eq(userSnapshots.id, snap.id));

      const result = await restoreSnapshotForUser({
        userId: userA,
        snapshotId: snap.id,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("schema_mismatch");
      }
    });
  });

  describe("listing + ordering", () => {
    it("returns snapshots newest first for the calling user only", async () => {
      await createSnapshotForUser({ userId: userA, name: "older" });
      // A 10ms spin keeps createdAt ordering deterministic on fast machines
      // where consecutive INSERTs land inside the same millisecond.
      await new Promise((r) => setTimeout(r, 10));
      const newer = await createSnapshotForUser({ userId: userA, name: "newer" });
      await createSnapshotForUser({ userId: userB, name: "other-user" });

      const rowsA = await db
        .select({ id: userSnapshots.id, name: userSnapshots.name })
        .from(userSnapshots)
        .where(eq(userSnapshots.userId, userA))
        .orderBy(desc(userSnapshots.createdAt));

      expect(rowsA[0].id).toBe(newer.id);
      expect(rowsA.every((r) => r.name !== "other-user")).toBe(true);
    });
  });
});
