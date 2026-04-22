import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, statementImports, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

import {
  currentCycleFor,
  latestConsolidationsForUser,
  overdueCyclesForUser,
  previousCycle,
  recentCycles,
  resolveCutoffDay,
} from "./cycles";

const TAG = "CYCLES_TEST";

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
}

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createTc(userId: number, cutoffDay: number, name: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} ${name}`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "credit_card",
      currency: "COP",
      metadata: { last4s: ["9999"], cutoffDay },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(statementImports).where(eq(statementImports.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe("resolveCutoffDay", () => {
  it("returns metadata.cutoffDay when valid", () => {
    expect(resolveCutoffDay({ cutoffDay: 15 })).toBe(15);
  });
  it("falls back to 31 when missing or invalid", () => {
    expect(resolveCutoffDay(null)).toBe(31);
    expect(resolveCutoffDay(undefined)).toBe(31);
    expect(resolveCutoffDay({})).toBe(31);
    expect(resolveCutoffDay({ cutoffDay: 0 })).toBe(31);
    expect(resolveCutoffDay({ cutoffDay: 99 })).toBe(31);
  });
});

describe("previousCycle", () => {
  it("decrements within a year", () => {
    expect(previousCycle("2026-04")).toBe("2026-03");
  });
  it("rolls January back to December of the previous year", () => {
    expect(previousCycle("2026-01")).toBe("2025-12");
  });
  it("throws on malformed input", () => {
    expect(() => previousCycle("foo")).toThrow();
  });
});

describe("currentCycleFor", () => {
  it("returns same-month cycle when reference is before the cut", () => {
    expect(currentCycleFor(utcDate(2026, 4, 15), 30)).toBe("2026-04");
  });
  it("advances to next month when reference is past the cut", () => {
    expect(currentCycleFor(utcDate(2026, 4, 30), 15)).toBe("2026-05");
  });
  it("rolls December→January across the year boundary", () => {
    expect(currentCycleFor(utcDate(2026, 12, 31), 15)).toBe("2027-01");
  });
  it("clamps Feb cut to month-length (cutDay=31 in Feb = Feb 28)", () => {
    // Feb 27 is before Feb 28 cut → current cycle is 2026-02.
    expect(currentCycleFor(utcDate(2026, 2, 27), 31)).toBe("2026-02");
    // Feb 28 end-of-day ≥ anchor (23:00) but we use noon → anchor > ref → still 2026-02.
    expect(currentCycleFor(utcDate(2026, 2, 28), 31)).toBe("2026-02");
  });
});

describe("recentCycles — integration", () => {
  let userId!: number;
  let accountId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    accountId = await createTc(userId, 30, "visa");

    // Mark 2026-03 as consolidated.
    await db.insert(statementImports).values({
      userId,
      accountId,
      fileHash: "a".repeat(64),
      periodStart: "2026-02-28",
      periodEnd: "2026-03-30",
      kind: "extracto_detallado",
      cycle: "2026-03",
      report: { marker: "test-fixture" },
    });
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("returns N most recent cycles with statuses", async () => {
    const cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    expect(cycles.map((c) => c.cycle)).toEqual(["2026-04", "2026-03", "2026-02", "2026-01"]);
    expect(cycles[0].status).toBe("in-progress");
    expect(cycles[1].status).toBe("consolidated");
    expect(cycles[1].consolidatedAt).toBeInstanceOf(Date);
    expect(cycles[2].status).toBe("pending");
    expect(cycles[2].daysOverdue).toBeGreaterThan(0);
    expect(cycles[3].status).toBe("pending");
  });

  it("overdueCyclesForUser flags cycles past threshold", async () => {
    const overdue = await overdueCyclesForUser(
      userId,
      [{ id: accountId, name: "visa", metadata: { cutoffDay: 30 } }],
      { thresholdDays: 7, now: utcDate(2026, 4, 15), count: 4 },
    );
    // 2026-03 is consolidated (excluded). 2026-02 cut was Feb 28; Apr 15 is
    // ~46 days later → overdue. 2026-01 even more overdue.
    const cycles = overdue.map((o) => o.cycle);
    expect(cycles).toContain("2026-02");
    expect(cycles).toContain("2026-01");
    expect(cycles).not.toContain("2026-03");
  });

  it("latestConsolidationsForUser returns the seeded row", async () => {
    const recents = await latestConsolidationsForUser(userId, { limit: 5 });
    expect(recents).toHaveLength(1);
    expect(recents[0].cycle).toBe("2026-03");
    expect(recents[0].accountId).toBe(accountId);
  });
});
