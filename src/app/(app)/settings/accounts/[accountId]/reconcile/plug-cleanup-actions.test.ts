import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, transactions, users } from "@/lib/db/schema";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

const TAG = "PLUG_CLEAN_TEST";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sessionMock = { id: 0, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

const { archiveBalanceAdjustmentsAction, restoreBalanceAdjustmentAction } =
  await import("./plug-cleanup-actions");

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createTc(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} visa`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "credit_card",
      currency: "COP",
      metadata: { last4s: ["9999"], cutoffDay: 30 },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function insertPlug(userId: number, accountId: number, amountCents: bigint): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-03-30T12:00:00Z"),
      amountCents,
      currency: "COP",
      descriptionRaw: `${TAG} plug ${amountCents}`,
      categorySlug: "adjustments",
      classificationMethod: "manual",
      source: "balance_adjustment",
      channel: "manual",
      isAdjustment: true,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function insertNonPlug(userId: number, accountId: number): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-03-10T12:00:00Z"),
      amountCents: BigInt(-100_000),
      currency: "COP",
      descriptionRaw: `${TAG} regular purchase`,
      categorySlug: "adjustments",
      classificationMethod: "manual",
      source: "manual",
      channel: "bank",
    })
    .returning({ id: transactions.id });
  return row.id;
}

function archiveFd(accountId: number, txIds: number[]): FormData {
  const fd = new FormData();
  fd.set("accountId", String(accountId));
  fd.set("txIds", JSON.stringify(txIds));
  return fd;
}

describe("archiveBalanceAdjustmentsAction / restoreBalanceAdjustmentAction (#434)", () => {
  let userId!: number;
  let otherUserId!: number;
  let accountId!: number;
  let otherAccountId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    otherUserId = await createUser(`${TAG.toLowerCase()}.other.${Date.now()}@test.local`);
    sessionMock.id = userId;
    accountId = await createTc(userId);
    otherAccountId = await createTc(otherUserId);
  });

  beforeEach(async () => {
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(transactions).where(eq(transactions.userId, otherUserId));
  });

  afterAll(async () => {
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(transactions).where(eq(transactions.userId, otherUserId));
    await db.delete(accounts).where(eq(accounts.userId, userId));
    await db.delete(accounts).where(eq(accounts.userId, otherUserId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  it("soft-deletes the selected plugs and returns the new derived balance", async () => {
    const plug1 = await insertPlug(userId, accountId, BigInt(-100_000)); // -1.000,00 COP
    const plug2 = await insertPlug(userId, accountId, BigInt(-50_000)); // -500,00 COP
    const plug3 = await insertPlug(userId, accountId, BigInt(200_000)); // +2.000,00 COP

    const result = await archiveBalanceAdjustmentsAction(archiveFd(accountId, [plug1, plug3]));
    expect(result.archivedCount).toBe(2);
    // Remaining live: only plug2 → balance = -50_000.
    expect(result.newBalanceCentsStr).toBe("-50000");

    // DB side: 2 rows have deletedAt, 1 is still live.
    const live = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, accountId),
          isNull(transactions.deletedAt),
        ),
      );
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(plug2);
  });

  it("batch is idempotent — second call on already-deleted rows is a no-op", async () => {
    const plug1 = await insertPlug(userId, accountId, BigInt(-100_000));
    await archiveBalanceAdjustmentsAction(archiveFd(accountId, [plug1]));
    const result = await archiveBalanceAdjustmentsAction(archiveFd(accountId, [plug1]));
    expect(result.archivedCount).toBe(0);
  });

  it("skips non-plug txs even when their ids are in the batch", async () => {
    const plug1 = await insertPlug(userId, accountId, BigInt(-100_000));
    const nonPlug = await insertNonPlug(userId, accountId);

    const result = await archiveBalanceAdjustmentsAction(archiveFd(accountId, [plug1, nonPlug]));
    expect(result.archivedCount).toBe(1);

    // The non-plug tx remains live + undeleted.
    const [row] = await db
      .select({ deletedAt: transactions.deletedAt })
      .from(transactions)
      .where(eq(transactions.id, nonPlug));
    expect(row.deletedAt).toBeNull();
  });

  it("tenancy guard: rejects an accountId that doesn't belong to the session user", async () => {
    await expect(archiveBalanceAdjustmentsAction(archiveFd(otherAccountId, [1]))).rejects.toThrow(
      /account_not_found/,
    );
  });

  it("rejects when txIds is missing or not JSON", async () => {
    const fd = new FormData();
    fd.set("accountId", String(accountId));
    await expect(archiveBalanceAdjustmentsAction(fd)).rejects.toThrow(/tx_ids_missing/);

    const fd2 = new FormData();
    fd2.set("accountId", String(accountId));
    fd2.set("txIds", "not-json");
    await expect(archiveBalanceAdjustmentsAction(fd2)).rejects.toThrow(/tx_ids_not_json/);
  });

  it("restore un-archives a soft-deleted plug and leaves live ones alone", async () => {
    const plug1 = await insertPlug(userId, accountId, BigInt(-100_000));
    await archiveBalanceAdjustmentsAction(archiveFd(accountId, [plug1]));

    const fd = new FormData();
    fd.set("accountId", String(accountId));
    fd.set("txId", String(plug1));
    const result = await restoreBalanceAdjustmentAction(fd);
    expect(result.restored).toBe(true);

    const [row] = await db
      .select({ deletedAt: transactions.deletedAt })
      .from(transactions)
      .where(eq(transactions.id, plug1));
    expect(row.deletedAt).toBeNull();

    // Second restore on an already-live row is a no-op.
    const second = await restoreBalanceAdjustmentAction(fd);
    expect(second.restored).toBe(false);
  });

  it("derived balance excludes soft-deleted plugs", async () => {
    const plug1 = await insertPlug(userId, accountId, BigInt(-100_000));
    const plug2 = await insertPlug(userId, accountId, BigInt(-50_000));

    const [before] = await db
      .select({ cents: derivedBalanceCentsSql })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(BigInt(before.cents)).toBe(BigInt(-150_000));

    await archiveBalanceAdjustmentsAction(archiveFd(accountId, [plug1]));

    const [after] = await db
      .select({ cents: derivedBalanceCentsSql })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    expect(BigInt(after.cents)).toBe(BigInt(-50_000));
    // Only plug2 remains live.
    void plug2;
  });
});
