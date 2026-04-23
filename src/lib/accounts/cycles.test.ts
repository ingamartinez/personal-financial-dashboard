import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  accounts,
  skippedConsolidationCycles,
  statementImports,
  transactions,
  users,
} from "@/lib/db/schema";
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
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(skippedConsolidationCycles).where(eq(skippedConsolidationCycles.userId, userId));
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

    // #430: cycles without txs are demoted to `no-activity`. Seed one
    // purchase in each past window so these pre-existing tests (which
    // predate the demotion) still exercise the `pending` classification.
    // Windows (cutoff=30): 2026-01 = (Dec 30, Jan 30], 2026-02 = (Jan 30, Feb 28].
    await db.insert(transactions).values([
      {
        userId,
        accountId,
        occurredAt: utcDate(2026, 1, 15),
        amountCents: BigInt(-1000),
        currency: "COP",
        descriptionRaw: `${TAG} pending-jan-window`,
        categorySlug: "adjustments",
        classificationMethod: "manual",
        source: "manual",
        channel: "manual",
      },
      {
        userId,
        accountId,
        occurredAt: utcDate(2026, 2, 15),
        amountCents: BigInt(-2000),
        currency: "COP",
        descriptionRaw: `${TAG} pending-feb-window`,
        categorySlug: "adjustments",
        classificationMethod: "manual",
        source: "manual",
        channel: "manual",
      },
    ]);
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

describe("recentCycles — no-activity (#430)", () => {
  let userId!: number;
  let accountId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.noact.${Date.now()}@test.local`);
    accountId = await createTc(userId, 30, "noact-visa");
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  async function clearTxs(): Promise<void> {
    await db.delete(transactions).where(eq(transactions.userId, userId));
  }

  it("demotes pending cycles to no-activity when the window has zero live txs", async () => {
    await clearTxs();
    const cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    // 2026-04 = in-progress, 2026-03, 2026-02, 2026-01 = all past cuts.
    expect(cycles[0].status).toBe("in-progress");
    for (let i = 1; i < cycles.length; i++) {
      expect(cycles[i].status).toBe("no-activity");
      expect(cycles[i].daysOverdue).toBe(0);
    }
  });

  it("keeps a cycle pending when the window has at least one live tx", async () => {
    await clearTxs();
    // One purchase on 2026-03-15, inside (2026-02-28, 2026-03-30] → pending.
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: utcDate(2026, 3, 15),
      amountCents: BigInt(-50000),
      currency: "COP",
      descriptionRaw: `${TAG} noact tx march`,
      categorySlug: "adjustments",
      classificationMethod: "manual",
      source: "manual",
      channel: "manual",
    });
    const cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    const byCycle = new Map(cycles.map((c) => [c.cycle, c]));
    expect(byCycle.get("2026-03")?.status).toBe("pending");
    expect(byCycle.get("2026-03")?.daysOverdue).toBeGreaterThan(0);
    expect(byCycle.get("2026-02")?.status).toBe("no-activity");
    expect(byCycle.get("2026-01")?.status).toBe("no-activity");
  });

  it("ignores synthetic intereses-causados txs when counting activity", async () => {
    await clearTxs();
    // Synthetic tx from intereses-causados-job — rawData.synthetic = true.
    // Anchor is end-of-day on cut day, which IS within (prev_anchor, anchor].
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: utcDate(2026, 3, 30),
      amountCents: BigInt(-10000),
      currency: "COP",
      descriptionRaw: `${TAG} synthetic intereses`,
      categorySlug: "intereses-tc",
      classificationMethod: "manual",
      source: "manual",
      channel: "manual",
      rawData: { synthetic: true, job: "intereses-causados-job" },
    });
    const cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    const march = cycles.find((c) => c.cycle === "2026-03");
    expect(march?.status).toBe("no-activity");
  });

  it("ignores soft-deleted txs when counting activity", async () => {
    await clearTxs();
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: utcDate(2026, 3, 15),
      amountCents: BigInt(-1234),
      currency: "COP",
      descriptionRaw: `${TAG} deleted tx`,
      categorySlug: "adjustments",
      classificationMethod: "manual",
      source: "manual",
      channel: "manual",
      deletedAt: new Date(),
    });
    const cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    const march = cycles.find((c) => c.cycle === "2026-03");
    expect(march?.status).toBe("no-activity");
  });

  it("flips no-activity back to pending when a backfill tx lands in the window", async () => {
    await clearTxs();
    let cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    expect(cycles.find((c) => c.cycle === "2026-02")?.status).toBe("no-activity");

    // Simulate a historical import (SMS dump, CSV, extracto) into Feb window.
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: utcDate(2026, 2, 10),
      amountCents: BigInt(-999),
      currency: "COP",
      descriptionRaw: `${TAG} backfill`,
      categorySlug: "adjustments",
      classificationMethod: "manual",
      source: "manual",
      channel: "manual",
    });

    cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    const feb = cycles.find((c) => c.cycle === "2026-02");
    expect(feb?.status).toBe("pending");
    expect(feb?.daysOverdue).toBeGreaterThan(0);
  });

  it("overdueCyclesForUser excludes no-activity cycles from the banner feed", async () => {
    await clearTxs();
    const overdue = await overdueCyclesForUser(
      userId,
      [{ id: accountId, name: "noact", metadata: { cutoffDay: 30 } }],
      { thresholdDays: 7, now: utcDate(2026, 4, 15), count: 4 },
    );
    expect(overdue).toHaveLength(0);
  });
});

describe("recentCycles — skipped (#436)", () => {
  let userId!: number;
  let accountId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.skip.${Date.now()}@test.local`);
    accountId = await createTc(userId, 30, "skip-visa");
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  async function resetState(): Promise<void> {
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(statementImports).where(eq(statementImports.userId, userId));
    await db
      .delete(skippedConsolidationCycles)
      .where(eq(skippedConsolidationCycles.userId, userId));
  }

  async function seedMarchActivity(): Promise<void> {
    // One purchase inside (2026-02-28, 2026-03-30] → March classifies as pending.
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: utcDate(2026, 3, 15),
      amountCents: BigInt(-50000),
      currency: "COP",
      descriptionRaw: `${TAG} skip march tx`,
      categorySlug: "adjustments",
      classificationMethod: "manual",
      source: "manual",
      channel: "manual",
    });
  }

  it("promotes a pending cycle to skipped when a live skip row exists", async () => {
    await resetState();
    await seedMarchActivity();

    let cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    expect(cycles.find((c) => c.cycle === "2026-03")?.status).toBe("pending");

    await db.insert(skippedConsolidationCycles).values({
      userId,
      accountId,
      cycle: "2026-03",
      reason: "ya cuadré a mano",
    });

    cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    const march = cycles.find((c) => c.cycle === "2026-03");
    expect(march?.status).toBe("skipped");
    expect(march?.daysOverdue).toBe(0);
  });

  it("soft-deleted skip rows do NOT promote — cycle returns to its derived status", async () => {
    await resetState();
    await seedMarchActivity();

    await db.insert(skippedConsolidationCycles).values({
      userId,
      accountId,
      cycle: "2026-03",
      deletedAt: new Date(),
    });

    const cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    expect(cycles.find((c) => c.cycle === "2026-03")?.status).toBe("pending");
  });

  it("statement_imports row wins over skip (consolidated prevails)", async () => {
    await resetState();
    await seedMarchActivity();
    await db.insert(statementImports).values({
      userId,
      accountId,
      fileHash: "b".repeat(64),
      periodStart: "2026-02-28",
      periodEnd: "2026-03-30",
      kind: "extracto_detallado",
      cycle: "2026-03",
      report: { marker: "skip-wins-test" },
    });
    await db.insert(skippedConsolidationCycles).values({
      userId,
      accountId,
      cycle: "2026-03",
    });

    const cycles = await recentCycles({
      accountId,
      userId,
      metadata: { cutoffDay: 30 },
      count: 4,
      now: utcDate(2026, 4, 15),
    });
    expect(cycles.find((c) => c.cycle === "2026-03")?.status).toBe("consolidated");
  });

  it("banner feed (overdueCyclesForUser) excludes skipped cycles", async () => {
    await resetState();
    // Seed Jan + Feb activity so both cycles classify as `pending` naturally.
    await db.insert(transactions).values([
      {
        userId,
        accountId,
        occurredAt: utcDate(2026, 1, 15),
        amountCents: BigInt(-1000),
        currency: "COP",
        descriptionRaw: `${TAG} skip-jan`,
        categorySlug: "adjustments",
        classificationMethod: "manual",
        source: "manual",
        channel: "manual",
      },
      {
        userId,
        accountId,
        occurredAt: utcDate(2026, 2, 15),
        amountCents: BigInt(-1000),
        currency: "COP",
        descriptionRaw: `${TAG} skip-feb`,
        categorySlug: "adjustments",
        classificationMethod: "manual",
        source: "manual",
        channel: "manual",
      },
    ]);
    // Skip Feb only.
    await db.insert(skippedConsolidationCycles).values({
      userId,
      accountId,
      cycle: "2026-02",
    });

    const overdue = await overdueCyclesForUser(
      userId,
      [{ id: accountId, name: "skip-visa", metadata: { cutoffDay: 30 } }],
      { thresholdDays: 7, now: utcDate(2026, 4, 15), count: 4 },
    );
    const cycles = overdue.map((o) => o.cycle);
    expect(cycles).not.toContain("2026-02");
    expect(cycles).toContain("2026-01");
  });
});
