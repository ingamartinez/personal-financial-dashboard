import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { detectRecurringAdjustmentInsight } from "./insights";

const TAG = "RECURRING_INSIGHT_TEST";
const NOW = new Date("2026-04-19T12:00:00Z");
const DAY_MS = 86_400_000;

function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function seedUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function seedAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} acct`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedAdjustment(
  userId: number,
  accountId: number,
  amountCents: bigint,
  occurredAt: Date,
): Promise<void> {
  await db.insert(transactions).values({
    userId,
    accountId,
    occurredAt,
    amountCents,
    currency: "COP",
    descriptionRaw: `${TAG} adj`,
    source: "balance_adjustment",
    channel: "manual",
    isAdjustment: true,
  });
}

describe("detectRecurringAdjustmentInsight", () => {
  let userId!: number;
  let accountId!: number;

  beforeAll(async () => {
    userId = await seedUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    accountId = await seedAccount(userId);
  });

  beforeEach(async () => {
    await db.delete(transactions).where(eq(transactions.userId, userId));
  });

  afterAll(async () => {
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(accounts).where(eq(accounts.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("returns null when the user has zero adjustments", async () => {
    expect(await detectRecurringAdjustmentInsight(userId, NOW)).toBeNull();
  });

  it("returns null when there are fewer than 3 adjustments", async () => {
    await seedAdjustment(userId, accountId, BigInt(10_000), ago(1));
    await seedAdjustment(userId, accountId, BigInt(10_000), ago(2));
    expect(await detectRecurringAdjustmentInsight(userId, NOW)).toBeNull();
  });

  it("fires when 3+ adjustments are all positive (in-direction)", async () => {
    await seedAdjustment(userId, accountId, BigInt(10_000_00), ago(1));
    await seedAdjustment(userId, accountId, BigInt(5_000_00), ago(5));
    await seedAdjustment(userId, accountId, BigInt(3_000_00), ago(15));

    const signal = await detectRecurringAdjustmentInsight(userId, NOW);
    expect(signal).not.toBeNull();
    expect(signal?.direction).toBe("in");
    expect(signal?.count).toBe(3);
    expect(signal?.totalCents).toBe(BigInt(18_000_00));
    expect(signal?.message).toContain("3 adjustments");
    expect(signal?.message).toMatch(/adding/);
    expect(signal?.windowDays).toBe(30);
  });

  it("fires when 3+ adjustments are all negative (out-direction)", async () => {
    await seedAdjustment(userId, accountId, BigInt(-10_000_00), ago(1));
    await seedAdjustment(userId, accountId, BigInt(-5_000_00), ago(5));
    await seedAdjustment(userId, accountId, BigInt(-3_000_00), ago(15));

    const signal = await detectRecurringAdjustmentInsight(userId, NOW);
    expect(signal?.direction).toBe("out");
    expect(signal?.totalCents).toBe(BigInt(-18_000_00));
    expect(signal?.message).toMatch(/subtracting/);
  });

  it("returns null when adjustments mix direction", async () => {
    await seedAdjustment(userId, accountId, BigInt(10_000_00), ago(1));
    await seedAdjustment(userId, accountId, BigInt(-5_000_00), ago(5));
    await seedAdjustment(userId, accountId, BigInt(3_000_00), ago(15));
    expect(await detectRecurringAdjustmentInsight(userId, NOW)).toBeNull();
  });

  it("ignores adjustments older than the 30-day window", async () => {
    await seedAdjustment(userId, accountId, BigInt(10_000_00), ago(40));
    await seedAdjustment(userId, accountId, BigInt(5_000_00), ago(45));
    await seedAdjustment(userId, accountId, BigInt(3_000_00), ago(50));
    expect(await detectRecurringAdjustmentInsight(userId, NOW)).toBeNull();
  });

  it("counts only inside-window adjustments when the window overlaps old data", async () => {
    // 2 inside, 1 outside → only 2 count → below threshold → null
    await seedAdjustment(userId, accountId, BigInt(10_000_00), ago(5));
    await seedAdjustment(userId, accountId, BigInt(5_000_00), ago(10));
    await seedAdjustment(userId, accountId, BigInt(3_000_00), ago(40));
    expect(await detectRecurringAdjustmentInsight(userId, NOW)).toBeNull();
  });
});
