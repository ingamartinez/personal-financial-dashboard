import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringGaps,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import {
  closePreviousMonthForAllUsers,
  detectGapsForMonth,
  previousYearMonth,
} from "./gap-detector";

const TEST_ACCOUNT = "__gap_test_account__";

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_gaps WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__gap_test%')`,
  );
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__gap_test%'`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE '__gap_test%'`);
  await db.execute(sql`DELETE FROM accounts WHERE name = ${TEST_ACCOUNT}`);
}

const TEST_USER_ID = 1;

async function seedAccount() {
  const [a] = await db
    .insert(accounts)
    .values({
      userId: TEST_USER_ID,
      name: TEST_ACCOUNT,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return a.id;
}

async function seedRecurring(
  accountId: number,
  opts: {
    label: string;
    amountCents: bigint;
    dayOfMonth: number;
    skippedMonths?: string[];
  },
) {
  const [r] = await db
    .insert(recurringTransactions)
    .values({
      userId: TEST_USER_ID,
      accountId,
      label: opts.label,
      amountCents: opts.amountCents,
      currency: "COP",
      dayOfMonth: opts.dayOfMonth,
      active: true,
      skippedMonths: opts.skippedMonths ?? [],
    })
    .returning({ id: recurringTransactions.id });
  return r.id;
}

async function seedTx(
  accountId: number,
  opts: {
    occurredOn: string;
    amountCents: bigint;
    description?: string;
    recurringId?: number;
    recurringYearMonth?: string;
  },
) {
  const [t] = await db
    .insert(transactions)
    .values({
      userId: TEST_USER_ID,
      accountId,
      occurredAt: new Date(`${opts.occurredOn}T12:00:00-05:00`),
      amountCents: opts.amountCents,
      currency: "COP",
      descriptionRaw: opts.description ?? "__gap_test_tx",
      source: "manual",
      recurringId: opts.recurringId ?? null,
      recurringYearMonth: opts.recurringYearMonth ?? null,
    })
    .returning({ id: transactions.id });
  return t.id;
}

describe("previousYearMonth", () => {
  it("returns the month before today in UTC", () => {
    expect(previousYearMonth(new Date("2026-05-05T12:00:00Z"))).toBe("2026-04");
    expect(previousYearMonth(new Date("2026-01-05T12:00:00Z"))).toBe("2025-12");
  });
});

describe("detectGapsForMonth (integration)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns empty result when no active recurrings exist", async () => {
    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.checkedRecurrings).toBe(0);
    expect(result.gapsCreated).toBe(0);
  });

  it("creates a gap when no transaction matches a recurring", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test rent",
      amountCents: BigInt(-2500000),
      dayOfMonth: 1,
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.gapsCreated).toBe(1);
    expect(result.autoLinked).toBe(0);
    expect(result.existingLinks).toBe(0);

    const rows = await db.execute<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM recurring_gaps WHERE year_month = '2026-04'`,
    );
    expect(rows[0]?.c).toBe("1");
  });

  it("auto-links an unlinked tx that matches account + amount within window", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test rent",
      amountCents: BigInt(-2500000),
      dayOfMonth: 1,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-03-29",
      amountCents: BigInt(-2500000),
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(1);
    expect(result.gapsCreated).toBe(0);

    const [linked] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recId);
    expect(linked.recurringYearMonth).toBe("2026-04");
  });

  it("counts existing explicit links as such and does not create a gap", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test cuota",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-1500000),
      recurringId: recId,
      recurringYearMonth: "2026-04",
    });

    await detectGapsForMonth(TEST_USER_ID, "2026-04");

    // No gap should exist for this specific recurring
    const gaps = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recId), eq(recurringGaps.yearMonth, "2026-04")));
    expect(gaps.length).toBe(0);
  });

  it("skips months listed in skippedMonths — no gap created", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test netflix",
      amountCents: BigInt(-49000),
      dayOfMonth: 10,
      skippedMonths: ["2026-04"],
    });

    await detectGapsForMonth(TEST_USER_ID, "2026-04");

    const gaps = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recId), eq(recurringGaps.yearMonth, "2026-04")));
    expect(gaps.length).toBe(0);
  });

  it("does not match a tx that is already linked to another recurring", async () => {
    const accountId = await seedAccount();
    const recA = await seedRecurring(accountId, {
      label: "__gap_test A",
      amountCents: BigInt(-100000),
      dayOfMonth: 1,
    });
    await seedRecurring(accountId, {
      label: "__gap_test B",
      amountCents: BigInt(-100000),
      dayOfMonth: 1,
    });
    // Tx is already linked to recA → should NOT be claimed by recB
    await seedTx(accountId, {
      occurredOn: "2026-04-01",
      amountCents: BigInt(-100000),
      recurringId: recA,
      recurringYearMonth: "2026-04",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.existingLinks).toBe(1);
    expect(result.gapsCreated).toBe(1); // recB has no match → gap
  });

  it("respects asymmetric window — tx 10 days early auto-links", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test early pay",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });
    // tx on apr-1 (9 days before day 10 in April)
    await seedTx(accountId, {
      occurredOn: "2026-04-01",
      amountCents: BigInt(-100000),
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(1);
  });

  it("respects asymmetric window — tx 6 days after expected day is OUT of window", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test late pay",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });
    // tx on apr-16 (6 days after day 10)
    await seedTx(accountId, {
      occurredOn: "2026-04-16",
      amountCents: BigInt(-100000),
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(1);
  });

  it("is idempotent — re-running on the same month is a no-op", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test idem",
      amountCents: BigInt(-100000),
      dayOfMonth: 1,
    });

    const first = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(first.gapsCreated).toBe(1);

    const second = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(second.gapsCreated).toBe(0);
    expect(second.gapsAlreadyOpen).toBe(1);

    const count = await db.execute<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM recurring_gaps WHERE recurring_id = ${recId}`,
    );
    expect(count[0]?.c).toBe("1");
  });

  it("clamps dayOfMonth to month length for short months", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test day31",
      amountCents: BigInt(-100000),
      dayOfMonth: 31,
    });
    // February 2026 (non-leap — only 28 days). dayOfMonth=31 clamps to 28.
    // tx on feb-28 (the effective expected day) should auto-link.
    await seedTx(accountId, {
      occurredOn: "2026-02-28",
      amountCents: BigInt(-100000),
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-02");
    expect(result.autoLinked).toBe(1);
  });

  it("does not match a tx that differs in amount", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test variable",
      amountCents: BigInt(-200000),
      dayOfMonth: 5,
    });
    await seedTx(accountId, {
      occurredOn: "2026-04-05",
      amountCents: BigInt(-347000), // variable — different amount
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(1);
  });
});

describe("closePreviousMonthForAllUsers (integration)", () => {
  const SECOND_USER_EMAIL = "__gap_test_user2@example.com";
  const SECOND_ACCOUNT = "__gap_test_account_u2";

  async function cleanupFanout() {
    await cleanup();
    await db.execute(sql`DELETE FROM accounts WHERE name = ${SECOND_ACCOUNT}`);
    await db.execute(sql`DELETE FROM users WHERE email = ${SECOND_USER_EMAIL}`);
  }

  beforeEach(cleanupFanout);
  afterEach(cleanupFanout);

  it("runs closePreviousMonth for every user and returns per-user results", async () => {
    const acct1 = await seedAccount();
    await seedRecurring(acct1, {
      label: "__gap_test user1 rent",
      amountCents: BigInt(-250000),
      dayOfMonth: 5,
    });

    const [u2] = await db
      .insert(users)
      .values({ email: SECOND_USER_EMAIL, name: "Gap Fan-out Test" })
      .returning({ id: users.id });

    const [acct2] = await db
      .insert(accounts)
      .values({
        userId: u2.id,
        name: SECOND_ACCOUNT,
        institution: "Test",
        type: "savings",
        currency: "COP",
      })
      .returning({ id: accounts.id });

    await db.insert(recurringTransactions).values({
      userId: u2.id,
      accountId: acct2.id,
      label: "__gap_test user2 netflix",
      amountCents: BigInt(-49000),
      currency: "COP",
      dayOfMonth: 10,
      active: true,
      skippedMonths: [],
    });

    // today = 2026-05-05 → closes 2026-04
    const results = await closePreviousMonthForAllUsers(new Date("2026-05-05T12:00:00Z"));

    const u1Entry = results.find((r) => r.userId === TEST_USER_ID);
    const u2Entry = results.find((r) => r.userId === u2.id);

    expect(u1Entry?.ok).toBe(true);
    expect(u2Entry?.ok).toBe(true);

    if (u1Entry?.ok) {
      expect(u1Entry.result.yearMonth).toBe("2026-04");
      // seeded 1 recurring for user 1 in this test — real seed may add more,
      // so assert "at least our one" rather than an exact count.
      expect(u1Entry.result.checkedRecurrings).toBeGreaterThanOrEqual(1);
    }
    if (u2Entry?.ok) {
      expect(u2Entry.result.yearMonth).toBe("2026-04");
      expect(u2Entry.result.checkedRecurrings).toBe(1);
      expect(u2Entry.result.gapsCreated).toBe(1);
    }

    // Gap for user 2 is scoped to user 2's recurring
    const u2Gaps = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .innerJoin(recurringTransactions, eq(recurringGaps.recurringId, recurringTransactions.id))
      .where(and(eq(recurringTransactions.userId, u2.id), eq(recurringGaps.yearMonth, "2026-04")));
    expect(u2Gaps.length).toBe(1);
  });
});

// Keep the `and` import live — drizzle barrel exports trip tree-shakers.
void and;
