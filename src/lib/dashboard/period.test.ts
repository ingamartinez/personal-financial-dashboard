import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, counterparties, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";
import { updateUiPreferences } from "@/lib/preferences/repo";
import { getFinancialPeriod, getPayPeriodReadiness, currentCalendarMonth } from "./period";

const TAG = "+period-test@findash.local";

async function createUser(email: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email, name: "Period Test", role: "user", active: true, googleSub: `sub-${email}` })
    .returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  await copyRuleSeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: "Test Acct",
      institution: "PERIOD_TEST",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createSalaryCounterparty(userId: number, name: string): Promise<number> {
  const [row] = await db
    .insert(counterparties)
    .values({ userId, displayName: name, type: "merchant", isSalary: true })
    .returning({ id: counterparties.id });
  return row.id;
}

async function insertSalary(
  userId: number,
  accountId: number,
  counterpartyId: number,
  occurredAt: Date,
  amountCents: bigint,
  externalIdSuffix: string,
) {
  await db.insert(transactions).values({
    userId,
    accountId,
    counterpartyId,
    occurredAt,
    amountCents,
    currency: "COP",
    descriptionRaw: "Salary",
    categorySlug: "ingresos",
    classificationMethod: "manual",
    source: "manual",
    externalId: `period-test-${userId}-${externalIdSuffix}`,
  });
}

async function cleanup() {
  const tags = ["a", "b", "c"].map((p) => `${p}${TAG}`);
  const userRows = await db.select({ id: users.id }).from(users).where(inArray(users.email, tags));
  if (userRows.length === 0) return;
  const ids = userRows.map((u) => u.id);
  await db.delete(transactions).where(inArray(transactions.userId, ids));
  await db.delete(counterparties).where(inArray(counterparties.userId, ids));
  await db.delete(accounts).where(inArray(accounts.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

// Wall-clock helper — Bun vitest does not implement vi.setSystemTime, so the
// helper exposes wallNow as a parameter and tests inject deterministic values.
const REF_APR = new Date("2026-04-15T10:00:00Z");
const WALL_MAY = new Date("2026-05-15T10:00:00Z").getTime();
const WALL_APR = new Date("2026-04-15T10:00:00Z").getTime();

describe("dashboard/period", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  describe("currentCalendarMonth", () => {
    it("returns UTC month boundaries for the given date", () => {
      const range = currentCalendarMonth(REF_APR);
      expect(range.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
      expect(range.end.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    });
  });

  describe("getFinancialPeriod — mode = calendar (default)", () => {
    it("returns calendar range when mode is calendar, regardless of salary data", async () => {
      const userId = await createUser(`a${TAG}`);
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");
      // Plant several "real-looking" paychecks — should be ignored.
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-02-28T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "2",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-04-28T12:00:00Z"),
        BigInt(500_000_00),
        "3",
      );

      const period = await getFinancialPeriod(userId, REF_APR, WALL_MAY);
      expect(period.mode).toBe("calendar");
      expect(period.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
      expect(period.end.toISOString()).toBe("2026-05-01T00:00:00.000Z");
      expect(period.fallbackReason).toBeUndefined();
    });
  });

  describe("getFinancialPeriod — mode = pay_period", () => {
    it("anchors on latest paycheck before each month boundary (monthly leading payroll)", async () => {
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");

      // Monthly paychecks landing 1-3 days before each month
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-02-28T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "2",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-04-28T12:00:00Z"),
        BigInt(500_000_00),
        "3",
      );

      const period = await getFinancialPeriod(userId, REF_APR, WALL_MAY);
      expect(period.mode).toBe("pay_period");
      expect(period.start.toISOString()).toBe("2026-03-30T12:00:00.000Z");
      expect(period.end.toISOString()).toBe("2026-04-28T12:00:00.000Z");
      expect(period.fallbackReason).toBeUndefined();
    });

    it("biweekly paychecks: April period contains both quincenas", async () => {
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");

      // Biweekly: 14 mar, 30 mar, 14 abr, 28 abr, 14 may
      const dates = [
        "2026-03-14T12:00:00Z",
        "2026-03-30T12:00:00Z",
        "2026-04-14T12:00:00Z",
        "2026-04-28T12:00:00Z",
        "2026-05-14T12:00:00Z",
      ];
      for (let i = 0; i < dates.length; i++) {
        await insertSalary(userId, acc, cp, new Date(dates[i]), BigInt(250_000_00), `bi-${i}`);
      }

      const period = await getFinancialPeriod(userId, REF_APR, WALL_MAY);
      expect(period.mode).toBe("pay_period");
      // Anchor for Apr 1 is closest paycheck → Mar 30 (2 days)
      expect(period.start.toISOString()).toBe("2026-03-30T12:00:00.000Z");
      // Anchor for May 1 is closest → Apr 28 (3 days) over May 14 (13 days)
      expect(period.end.toISOString()).toBe("2026-04-28T12:00:00.000Z");
      // Mid-month paycheck Apr 14 lives INSIDE [Mar 30, Apr 28) ✓
      expect(period.start.getTime()).toBeLessThan(new Date("2026-04-14T12:00:00Z").getTime());
      expect(period.end.getTime()).toBeGreaterThan(new Date("2026-04-14T12:00:00Z").getTime());
    });

    it("filters out reimbursements (amounts <50% of paycheck median)", async () => {
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");

      // Real paychecks (median = 500_000_00 = 5_000_000 in pesos)
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-02-28T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "2",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-04-28T12:00:00Z"),
        BigInt(500_000_00),
        "3",
      );
      // Reimbursement landing close to a month boundary — would shift the
      // anchor to mid-month if the median filter let it through.
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-04-30T20:00:00Z"),
        BigInt(50_000_00),
        "reimb",
      );

      const period = await getFinancialPeriod(userId, REF_APR, WALL_MAY);
      expect(period.mode).toBe("pay_period");
      // If the reimbursement on Apr 30 leaked, the May-1 anchor would shift
      // to Apr 30 instead of staying at the legitimate paycheck Apr 28.
      expect(period.end.toISOString()).toBe("2026-04-28T12:00:00.000Z");
    });

    it("multiple salary counterparties: anchors on whichever paycheck is closest to each boundary", async () => {
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cpA = await createSalaryCounterparty(userId, "Empresa SAS");
      const cpB = await createSalaryCounterparty(userId, "Otro Empleo");

      // CpA pays last day of month (~30), CpB pays 3rd of month — both monthly
      await insertSalary(
        userId,
        acc,
        cpA,
        new Date("2026-02-28T12:00:00Z"),
        BigInt(500_000_00),
        "a1",
      );
      await insertSalary(
        userId,
        acc,
        cpA,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "a2",
      );
      await insertSalary(
        userId,
        acc,
        cpA,
        new Date("2026-04-29T12:00:00Z"),
        BigInt(500_000_00),
        "a3",
      );
      await insertSalary(
        userId,
        acc,
        cpB,
        new Date("2026-03-03T12:00:00Z"),
        BigInt(300_000_00),
        "b1",
      );
      await insertSalary(
        userId,
        acc,
        cpB,
        new Date("2026-04-03T12:00:00Z"),
        BigInt(300_000_00),
        "b2",
      );
      await insertSalary(
        userId,
        acc,
        cpB,
        new Date("2026-05-03T12:00:00Z"),
        BigInt(300_000_00),
        "b3",
      );

      const period = await getFinancialPeriod(userId, REF_APR, WALL_MAY);
      expect(period.mode).toBe("pay_period");
      // Sanity: period spans roughly one month regardless of which counterparty wins each anchor
      const periodDays = (period.end.getTime() - period.start.getTime()) / (1000 * 60 * 60 * 24);
      expect(periodDays).toBeGreaterThan(20);
      expect(periodDays).toBeLessThan(40);
    });

    it("projects end from median spacing when current-month next paycheck has not landed", async () => {
      // Wall clock mid-April. Last paycheck Mar 30, no Apr paycheck yet.
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");

      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-01-30T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-02-28T12:00:00Z"),
        BigInt(500_000_00),
        "2",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "3",
      );

      const period = await getFinancialPeriod(userId, REF_APR, WALL_APR);
      expect(period.mode).toBe("pay_period");
      expect(period.start.toISOString()).toBe("2026-03-30T12:00:00.000Z");
      // Projected end = Mar 30 + median spacing (~29 days)
      const expectedEnd = new Date(period.start.getTime() + 29 * 24 * 60 * 60 * 1000);
      const diffDays =
        Math.abs(period.end.getTime() - expectedEnd.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeLessThan(2);
    });

    it("falls back to calendar with no_salary_flagged when user has no salary counterparty", async () => {
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });

      const period = await getFinancialPeriod(userId, REF_APR, WALL_MAY);
      expect(period.mode).toBe("calendar");
      expect(period.fallbackReason).toBe("no_salary_flagged");
    });

    it("falls back to calendar with insufficient_history when <2 paychecks pass the filter", async () => {
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );

      const period = await getFinancialPeriod(userId, REF_APR, WALL_MAY);
      expect(period.mode).toBe("calendar");
      expect(period.fallbackReason).toBe("insufficient_history");
    });

    it("falls back with no_recent_paycheck when no paycheck before monthStart", async () => {
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");
      // Paychecks landed ONLY in April — none before April → no anchor for monthStart
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-04-15T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-04-29T12:00:00Z"),
        BigInt(500_000_00),
        "2",
      );

      const period = await getFinancialPeriod(userId, REF_APR, WALL_APR);
      expect(period.mode).toBe("calendar");
      expect(period.fallbackReason).toBe("no_recent_paycheck");
    });

    it("past month with sparse data falls back to calendar (insufficient_history)", async () => {
      // Wall clock is May. Querying Feb but only have Jan paycheck and a much later one.
      const userId = await createUser(`a${TAG}`);
      await updateUiPreferences(userId, { financialCycleMode: "pay_period" });
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-01-30T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-04-28T12:00:00Z"),
        BigInt(500_000_00),
        "2",
      );
      // Spacing = 88 days, anchorWindow = 88 * 0.75 ≈ 66 days
      // For Feb 1: closest is Jan 30 (2 days) ✓ start = Jan 30
      // For Mar 1: closest is Jan 30 (30 days) within window → end == start
      // Past month (wall clock = May 15) → fallback insufficient_history

      const period = await getFinancialPeriod(userId, new Date("2026-02-15T10:00:00Z"), WALL_MAY);
      expect(period.mode).toBe("calendar");
      expect(period.fallbackReason).toBe("insufficient_history");
    });
  });

  describe("getFinancialPeriod — tenant safety", () => {
    it("only considers salary txs from the requested user", async () => {
      const userA = await createUser(`a${TAG}`);
      const userB = await createUser(`b${TAG}`);
      await updateUiPreferences(userA, { financialCycleMode: "pay_period" });
      await updateUiPreferences(userB, { financialCycleMode: "pay_period" });
      const accB = await createAccount(userB);
      const cpB = await createSalaryCounterparty(userB, "Otra Empresa");

      // userB has full paycheck history — userA has nothing
      await insertSalary(
        userB,
        accB,
        cpB,
        new Date("2026-02-28T12:00:00Z"),
        BigInt(500_000_00),
        "b1",
      );
      await insertSalary(
        userB,
        accB,
        cpB,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "b2",
      );
      await insertSalary(
        userB,
        accB,
        cpB,
        new Date("2026-04-28T12:00:00Z"),
        BigInt(500_000_00),
        "b3",
      );

      const periodA = await getFinancialPeriod(userA, REF_APR, WALL_MAY);
      expect(periodA.mode).toBe("calendar");
      expect(periodA.fallbackReason).toBe("no_salary_flagged");

      const periodB = await getFinancialPeriod(userB, REF_APR, WALL_MAY);
      expect(periodB.mode).toBe("pay_period");
    });
  });

  describe("getPayPeriodReadiness", () => {
    it("returns ready=false with no salary flag", async () => {
      const userId = await createUser(`a${TAG}`);
      const r = await getPayPeriodReadiness(userId);
      expect(r).toEqual({ ready: false, hasSalaryFlag: false, paycheckCount: 0 });
    });

    it("returns ready=false with one paycheck", async () => {
      const userId = await createUser(`a${TAG}`);
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      const r = await getPayPeriodReadiness(userId);
      expect(r).toEqual({ ready: false, hasSalaryFlag: true, paycheckCount: 1 });
    });

    it("returns ready=true with two valid paychecks", async () => {
      const userId = await createUser(`a${TAG}`);
      const acc = await createAccount(userId);
      const cp = await createSalaryCounterparty(userId, "Empresa SAS");
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-02-28T12:00:00Z"),
        BigInt(500_000_00),
        "1",
      );
      await insertSalary(
        userId,
        acc,
        cp,
        new Date("2026-03-30T12:00:00Z"),
        BigInt(500_000_00),
        "2",
      );
      const r = await getPayPeriodReadiness(userId);
      expect(r).toEqual({ ready: true, hasSalaryFlag: true, paycheckCount: 2 });
    });
  });
});
