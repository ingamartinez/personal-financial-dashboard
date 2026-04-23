import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, skippedConsolidationCycles, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

const TAG = "SKIP_ACT_TEST";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sessionMock = { id: 0, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

const { skipCycleAction, unskipCycleAction } = await import("./skip-actions");

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

function fd(accountId: number, cycle: string, reason?: string): FormData {
  const f = new FormData();
  f.set("accountId", String(accountId));
  f.set("cycle", cycle);
  if (reason) f.set("reason", reason);
  return f;
}

describe("skipCycleAction / unskipCycleAction (#436)", () => {
  let userId!: number;
  let tcId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    sessionMock.id = userId;
    tcId = await createTc(userId);
  });

  afterAll(async () => {
    await db
      .delete(skippedConsolidationCycles)
      .where(eq(skippedConsolidationCycles.userId, userId));
    await db.delete(accounts).where(eq(accounts.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  async function liveSkipCount(cycle: string): Promise<number> {
    const rows = await db
      .select({ id: skippedConsolidationCycles.id })
      .from(skippedConsolidationCycles)
      .where(
        and(
          eq(skippedConsolidationCycles.userId, userId),
          eq(skippedConsolidationCycles.accountId, tcId),
          eq(skippedConsolidationCycles.cycle, cycle),
          isNull(skippedConsolidationCycles.deletedAt),
        ),
      );
    return rows.length;
  }

  it("rejects when the cycle is malformed", async () => {
    await expect(skipCycleAction(fd(tcId, "nope"))).rejects.toThrow();
    await expect(unskipCycleAction(fd(tcId, "nope"))).rejects.toThrow();
  });

  it("creates a live skip row and stores the reason", async () => {
    await skipCycleAction(fd(tcId, "2026-03", "no tengo el extracto"));
    const rows = await db
      .select({
        cycle: skippedConsolidationCycles.cycle,
        reason: skippedConsolidationCycles.reason,
        deletedAt: skippedConsolidationCycles.deletedAt,
      })
      .from(skippedConsolidationCycles)
      .where(
        and(
          eq(skippedConsolidationCycles.userId, userId),
          eq(skippedConsolidationCycles.accountId, tcId),
          eq(skippedConsolidationCycles.cycle, "2026-03"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("no tengo el extracto");
    expect(rows[0].deletedAt).toBeNull();
  });

  it("skip is idempotent when the cycle is already skipped", async () => {
    // Second call should NOT create a duplicate (unique partial index + guard).
    await skipCycleAction(fd(tcId, "2026-03", "otro motivo"));
    expect(await liveSkipCount("2026-03")).toBe(1);
  });

  it("unskip soft-deletes the live row", async () => {
    await unskipCycleAction(fd(tcId, "2026-03"));
    expect(await liveSkipCount("2026-03")).toBe(0);
    // Historical row still present with deletedAt set.
    const rows = await db
      .select({ deletedAt: skippedConsolidationCycles.deletedAt })
      .from(skippedConsolidationCycles)
      .where(
        and(
          eq(skippedConsolidationCycles.userId, userId),
          eq(skippedConsolidationCycles.accountId, tcId),
          eq(skippedConsolidationCycles.cycle, "2026-03"),
        ),
      );
    expect(rows.some((r) => r.deletedAt !== null)).toBe(true);
  });

  it("unskip is idempotent when nothing is skipped", async () => {
    await unskipCycleAction(fd(tcId, "2026-04")); // never skipped
    expect(await liveSkipCount("2026-04")).toBe(0);
  });

  it("re-skip after unskip creates a new live row", async () => {
    await skipCycleAction(fd(tcId, "2026-03"));
    expect(await liveSkipCount("2026-03")).toBe(1);
    // Two historical rows total (the first soft-deleted + the new live one).
    const all = await db
      .select({ id: skippedConsolidationCycles.id })
      .from(skippedConsolidationCycles)
      .where(
        and(
          eq(skippedConsolidationCycles.userId, userId),
          eq(skippedConsolidationCycles.accountId, tcId),
          eq(skippedConsolidationCycles.cycle, "2026-03"),
        ),
      );
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects when the account does not belong to the user", async () => {
    await expect(skipCycleAction(fd(99_999_999, "2026-05"))).rejects.toThrow(/account_not_found/);
    await expect(unskipCycleAction(fd(99_999_999, "2026-05"))).rejects.toThrow(/account_not_found/);
  });
});
