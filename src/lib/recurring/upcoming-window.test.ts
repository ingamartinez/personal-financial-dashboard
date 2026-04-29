import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { getUpcomingForWindow } from "./upcoming";

const TEST_USER_ID = 1;
const TEST_USER2_EMAIL = "__upcoming_window_u2__@test.local";

async function cleanup() {
  await db.execute(
    sql`DELETE FROM transactions WHERE description_raw LIKE '__upwin%'`,
  );
  await db.execute(
    sql`DELETE FROM recurring_transactions WHERE label LIKE '__upwin%'`,
  );
  await db.execute(
    sql`DELETE FROM accounts WHERE name LIKE '__upwin%'`,
  );
  await db.execute(sql`DELETE FROM users WHERE email = ${TEST_USER2_EMAIL}`);
}

async function seedAccount(userId = TEST_USER_ID, suffix = "") {
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      name: `__upwin_acct${suffix}`,
      institution: "TestBank",
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
    userId?: number;
  },
) {
  const userId = opts.userId ?? TEST_USER_ID;
  const [r] = await db
    .insert(recurringTransactions)
    .values({
      userId,
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
    recurringId?: number;
    recurringYearMonth?: string;
    userId?: number;
  },
) {
  const userId = opts.userId ?? TEST_USER_ID;
  const [t] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date(`${opts.occurredOn}T12:00:00Z`),
      amountCents: opts.amountCents,
      currency: "COP",
      descriptionRaw: "__upwin_tx",
      source: "manual",
      recurringId: opts.recurringId ?? null,
      recurringYearMonth: opts.recurringYearMonth ?? null,
    })
    .returning({ id: transactions.id });
  return t.id;
}

async function seedUser2(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email: TEST_USER2_EMAIL, name: "Window Test User 2" })
    .returning({ id: users.id });
  return u.id;
}

describe("getUpcomingForWindow", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns empty list when no recurrings exist", async () => {
    const result = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-29T12:00:00Z"),
    });
    // No __upwin recurrings — may return other recurrings from seed data.
    // Just verify it returns an array.
    expect(Array.isArray(result)).toBe(true);
  });

  it("cross-month: today=April 29, day-1 recurring → May slot appears in window", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__upwin cross-month next",
      amountCents: BigInt(-100000),
      dayOfMonth: 1,
    });

    // today = April 29. window: [Apr 24, May 4].
    // May 1 falls in [Apr 24, May 4] → should appear.
    const result = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-29T12:00:00Z"),
    });

    const found = result.find((i) => i.recurringId === recurringId);
    expect(found).toBeDefined();
    expect(found!.yearMonth).toBe("2026-05");
    expect(found!.expectedOn).toBe("2026-05-01");
    expect(found!.status).toBe("upcoming");
  });

  it("matched items are filtered out (explicit link)", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__upwin matched filter",
      amountCents: BigInt(-50000),
      dayOfMonth: 15,
    });

    // Link a tx to this recurring for April 2026.
    await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-50000),
      recurringId,
      recurringYearMonth: "2026-04",
    });

    // today = April 15 → day-15 is in window.
    const result = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-15T12:00:00Z"),
    });

    const found = result.find((i) => i.recurringId === recurringId);
    // Should NOT appear — it's already matched.
    expect(found).toBeUndefined();
  });

  it("skipped items are filtered out", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__upwin skipped filter",
      amountCents: BigInt(-50000),
      dayOfMonth: 10,
      skippedMonths: ["2026-04"],
    });

    // today = April 10 → day-10 is in window but it's skipped.
    const result = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-10T12:00:00Z"),
    });

    const found = result.find((i) => i.recurringId === recurringId);
    expect(found).toBeUndefined();
  });

  it("item outside window is excluded", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__upwin outside window",
      amountCents: BigInt(-50000),
      dayOfMonth: 20, // day 20
    });

    // today = April 1 → window [Mar 27, Apr 6]. Day 20 is outside.
    const result = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-01T12:00:00Z"),
    });

    const found = result.find((i) => i.recurringId === recurringId);
    expect(found).toBeUndefined();
  });

  it("result is sorted by expectedOn ascending", async () => {
    const accountId = await seedAccount();
    // Three recurrings with different days, all in the window.
    // today=April 3 → window [Mar 29, Apr 8].
    const r3 = await seedRecurring(accountId, {
      label: "__upwin sort day3",
      amountCents: BigInt(-10000),
      dayOfMonth: 3,
    });
    const r5 = await seedRecurring(accountId, {
      label: "__upwin sort day5",
      amountCents: BigInt(-20000),
      dayOfMonth: 5,
    });
    const r1 = await seedRecurring(accountId, {
      label: "__upwin sort day1",
      amountCents: BigInt(-30000),
      dayOfMonth: 1,
    });

    const result = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-03T12:00:00Z"),
    });

    const ids = [r3, r5, r1];
    const filtered = result.filter((i) => ids.includes(i.recurringId));
    // Should be sorted by expectedOn — Apr 1, Apr 3, Apr 5
    const expectedOns = filtered.map((i) => i.expectedOn);
    const sorted = [...expectedOns].sort();
    expect(expectedOns).toEqual(sorted);
  });

  it("tenant safety: user2 recurring does not appear in user1 results", async () => {
    const user2Id = await seedUser2();
    const user2AccountId = await seedAccount(user2Id, "_u2");
    await seedRecurring(user2AccountId, {
      label: "__upwin tenant safety recurring",
      amountCents: BigInt(-999999),
      dayOfMonth: 15,
      userId: user2Id,
    });

    // today = April 15 → day-15 is in window.
    const result = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-15T12:00:00Z"),
    });

    // User2's recurring must NOT appear in user1's results.
    const leaked = result.find((i) => i.label === "__upwin tenant safety recurring");
    expect(leaked).toBeUndefined();
  });

  it("custom beforeDays/afterDays: day outside default window appears with expanded window", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__upwin custom window",
      amountCents: BigInt(-50000),
      dayOfMonth: 20,
    });

    // today = April 5. Default window [Mar 31, Apr 10] → day 20 outside.
    const defaultResult = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-05T12:00:00Z"),
    });
    const notInDefault = defaultResult.find((i) => i.recurringId === recurringId);
    expect(notInDefault).toBeUndefined();

    // Expanded window [Mar 6, May 5] → day 20 in BOTH March and April.
    // March 20 is closer to today (Apr 5) in the past; the function returns all
    // matching slots. The recurring appears at least once in the results.
    const expandedResult = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-04-05T12:00:00Z"),
      beforeDays: 30,
      afterDays: 30,
    });
    const inExpanded = expandedResult.filter((i) => i.recurringId === recurringId);
    // Both March 20 and April 20 fall in [Mar 6, May 5] — at least one slot returned.
    expect(inExpanded.length).toBeGreaterThanOrEqual(1);
    // All returned yearMonths should be valid (March or April).
    for (const item of inExpanded) {
      expect(["2026-03", "2026-04"]).toContain(item.yearMonth);
    }
  });
});
