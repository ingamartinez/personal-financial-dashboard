import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringGaps,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { autoLinkTransaction } from "./auto-link";

const TEST_ACCOUNT = "__autolink_test_account__";
const TEST_USER_EMAIL = "__autolink_other_user__@test.local";

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_link_observations WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__autolink%')`,
  );
  await db.execute(
    sql`DELETE FROM recurring_description_patterns WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__autolink%')`,
  );
  await db.execute(
    sql`DELETE FROM recurring_gaps WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__autolink%')`,
  );
  // Delete all transactions belonging to any __autolink account (catches both
  // __autolink% descriptions AND custom descriptions seeded by #633 tests).
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${"__autolink_test_account__%"})`,
  );
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__autolink%'`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE '__autolink%'`);
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${"__autolink_test_account__%"}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${TEST_USER_EMAIL}`);
}

const TEST_USER_ID = 1;

/**
 * Seeds a temporary second user for cross-tenant tests.
 * Returns the seeded user id. Cleaned up via `cleanup()` (deletes by email).
 */
async function seedOtherUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: TEST_USER_EMAIL, name: "Autolink Other User" })
    .returning({ id: users.id });
  return row.id;
}

async function seedAccount(userId = TEST_USER_ID, nameSuffix = "") {
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      name: TEST_ACCOUNT + nameSuffix,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return a.id;
}

async function seedRecurringWithGap(
  accountId: number,
  opts: {
    label: string;
    amountCents: bigint;
    dayOfMonth: number;
    yearMonth: string;
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
    })
    .returning({ id: recurringTransactions.id });

  const [g] = await db
    .insert(recurringGaps)
    .values({ userId, recurringId: r.id, yearMonth: opts.yearMonth })
    .returning({ id: recurringGaps.id });

  return { recurringId: r.id, gapId: g.id };
}

async function seedRecurring(
  accountId: number,
  opts: {
    label: string;
    amountCents: bigint;
    dayOfMonth: number;
    active?: boolean;
    deletedAt?: Date;
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
      active: opts.active ?? true,
      deletedAt: opts.deletedAt ?? null,
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
    userId?: number;
  },
) {
  const userId = opts.userId ?? TEST_USER_ID;
  const [t] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date(`${opts.occurredOn}T12:00:00-05:00`),
      amountCents: opts.amountCents,
      currency: "COP",
      descriptionRaw: opts.description ?? "__autolink_tx",
      source: "manual",
      recurringId: opts.recurringId ?? null,
      recurringYearMonth: opts.recurringYearMonth ?? null,
    })
    .returning({ id: transactions.id });
  return t.id;
}

describe("autoLinkTransaction (integration)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns no-open-gap when no gap matches", async () => {
    const accountId = await seedAccount();
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(1, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("returns already-linked when the tx has a recurring_id set", async () => {
    const accountId = await seedAccount();
    const { recurringId } = await seedRecurringWithGap(accountId, {
      label: "__autolink already",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
      yearMonth: "2026-04",
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-100000),
      recurringId,
      recurringYearMonth: "2026-04",
    });
    const result = await autoLinkTransaction(1, txId);
    expect(result.status).toBe("already-linked");
  });

  it("links exactly one candidate and deletes the gap", async () => {
    const accountId = await seedAccount();
    const { recurringId, gapId } = await seedRecurringWithGap(accountId, {
      label: "__autolink exact",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
      yearMonth: "2026-04",
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(1, txId);
    expect(result.status).toBe("linked");

    const [linked] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recurringId);
    expect(linked.recurringYearMonth).toBe("2026-04");

    const gaps = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(eq(recurringGaps.id, gapId));
    expect(gaps.length).toBe(0);
  });

  it("returns ambiguous when two gaps match the same tx", async () => {
    const accountId = await seedAccount();
    // Same amount, same account, overlapping windows — ambiguous
    await seedRecurringWithGap(accountId, {
      label: "__autolink amb A",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
      yearMonth: "2026-04",
    });
    await seedRecurringWithGap(accountId, {
      label: "__autolink amb B",
      amountCents: BigInt(-100000),
      dayOfMonth: 12,
      yearMonth: "2026-04",
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-11",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(1, txId);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidateCount).toBe(2);
    }
  });

  it("does not match when amount differs", async () => {
    const accountId = await seedAccount();
    await seedRecurringWithGap(accountId, {
      label: "__autolink amt",
      amountCents: BigInt(-200000),
      dayOfMonth: 10,
      yearMonth: "2026-04",
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-347000),
    });
    const result = await autoLinkTransaction(1, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("does not match when outside the asymmetric window", async () => {
    const accountId = await seedAccount();
    await seedRecurringWithGap(accountId, {
      label: "__autolink window",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
      yearMonth: "2026-04",
    });
    // 6 days after day 10 → outside the +5 bound
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-16",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(1, txId);
    expect(result.status).toBe("no-open-gap");
  });
});

// ── Direct-recurring path (no gap exists yet — current month) ───────────────
describe("autoLinkTransaction direct-recurring path", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("happy path: links tx to active recurring with no gap and returns gapId: null", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink direct happy",
      amountCents: BigInt(-100000),
      dayOfMonth: 15,
    });
    // tx on day 15 of March 2026 — well inside the window
    const txId = await seedTx(accountId, {
      occurredOn: "2026-03-15",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.gapId).toBeNull();
      expect(result.recurringId).toBe(recurringId);
      expect(result.yearMonth).toBe("2026-03");
    }

    // Verify DB was updated
    const [linked] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recurringId);
    expect(linked.recurringYearMonth).toBe("2026-03");
  });

  it("sign convention: negative tx + negative recurring matches; negative tx + positive recurring does not", async () => {
    const accountId = await seedAccount();

    // Recurring with POSITIVE amount (income)
    await seedRecurring(accountId, {
      label: "__autolink sign positive",
      amountCents: BigInt(100000),
      dayOfMonth: 10,
    });

    // tx with NEGATIVE amount (expense)
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-100000),
    });

    // No match: signs differ
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("sign convention: both negative → match succeeds", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink sign both negative",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringId);
    }
  });

  it("window out: tx 6 days after dayOfMonth+5 → no match", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__autolink direct window",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });
    // dayOfMonth=10, window end = day 15 (10+5). Day 16 is outside.
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-16",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("window start: tx 10 days before dayOfMonth → matches", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink direct window start",
      amountCents: BigInt(-100000),
      dayOfMonth: 20,
    });
    // dayOfMonth=20, window start = day 10 (20-10). Day 10 is inside.
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringId);
    }
  });

  it("window before start: tx 11 days before dayOfMonth → no match", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__autolink direct window before",
      amountCents: BigInt(-100000),
      dayOfMonth: 20,
    });
    // dayOfMonth=20, window start = day 10. Day 9 is outside.
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-09",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("ambiguity: two active recurrings same account+amount in window → returns ambiguous count=2", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__autolink direct amb A",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });
    await seedRecurring(accountId, {
      label: "__autolink direct amb B",
      amountCents: BigInt(-100000),
      dayOfMonth: 12,
    });
    // Day 11 — inside both windows (10+5=15 and 12-10=2)
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-11",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidateCount).toBe(2);
    }
  });

  it("slot-taken: another tx already linked to (recurring, yearMonth) → returns no-open-gap without error", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink direct slot taken",
      amountCents: BigInt(-100000),
      dayOfMonth: 15,
    });

    // First tx claims the slot
    const txId1 = await seedTx(accountId, {
      occurredOn: "2026-03-15",
      amountCents: BigInt(-100000),
      description: "__autolink_tx_slot1",
      recurringId,
      recurringYearMonth: "2026-03",
    });
    void txId1; // already linked — used to occupy the slot

    // Second tx tries to link to the same recurring + yearMonth
    const txId2 = await seedTx(accountId, {
      occurredOn: "2026-03-15",
      amountCents: BigInt(-100000),
      description: "__autolink_tx_slot2",
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId2);
    // Slot is taken → unique index throws → we degrade gracefully
    expect(result.status).toBe("no-open-gap");

    // Verify txId2 was NOT linked
    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId2));
    expect(row.recurringId).toBeNull();
  });

  it("soft-deleted recurring → not matched", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__autolink direct deleted",
      amountCents: BigInt(-100000),
      dayOfMonth: 15,
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-03-15",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("inactive recurring → not matched", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__autolink direct inactive",
      amountCents: BigInt(-100000),
      dayOfMonth: 15,
      active: false,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-03-15",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("cross-tenant: userA tx does not link to userB recurring", async () => {
    const otherUserId = await seedOtherUser();
    const userAAccountId = await seedAccount(TEST_USER_ID, "_userA");
    const userBAccountId = await seedAccount(otherUserId, "_userB");

    // userB has a recurring on their account with the same amount
    await seedRecurring(userBAccountId, {
      label: "__autolink cross tenant recurring",
      amountCents: BigInt(-100000),
      dayOfMonth: 15,
      userId: otherUserId,
    });

    // userA has a tx on their account — same amount, same day
    const txId = await seedTx(userAAccountId, {
      occurredOn: "2026-03-15",
      amountCents: BigInt(-100000),
      userId: TEST_USER_ID,
    });

    // autoLinkTransaction called for userA — must NOT link to userB's recurring
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();
  });

  it("gap takes precedence: matching gap wins over matching active recurring", async () => {
    const accountId = await seedAccount();

    // Both a gap AND a direct recurring exist for the same account+amount
    const { recurringId: gapRecurringId, gapId } = await seedRecurringWithGap(accountId, {
      label: "__autolink gap precedence gap",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
      yearMonth: "2026-04",
    });

    // A separate active recurring (no gap) — same account+amount+window
    await seedRecurring(accountId, {
      label: "__autolink gap precedence direct",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    // Must link via the gap path (returns specific gapId)
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      // Gap path sets gapId to the actual gap row id
      expect(result.gapId).toBe(gapId);
      expect(result.recurringId).toBe(gapRecurringId);
    }

    // Gap must be deleted
    const gaps = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(eq(recurringGaps.id, gapId));
    expect(gaps.length).toBe(0);
  });
});

// ── Cross-month auto-link (#632) ─────────────────────────────────────────────
describe("autoLinkTransaction cross-month", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("tx on April 29 links to May 1 recurring (window [Apr 21, May 6])", async () => {
    const accountId = await seedAccount();
    // Recurring fires on day 1. Today is April 29 — within 5d before May 1.
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink cross-month next",
      amountCents: BigInt(-330010),
      dayOfMonth: 1,
    });
    // tx on April 29 (expected window: May 1 - 10d = Apr 21 to May 1 + 5d = May 6)
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-29",
      amountCents: BigInt(-330010),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      // Must link to May's yearMonth (the cross-month evaluation)
      expect(result.yearMonth).toBe("2026-05");
      expect(result.recurringId).toBe(recurringId);
      expect(result.gapId).toBeNull();
    }

    const [linked] = await db
      .select({ recurringYearMonth: transactions.recurringYearMonth })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringYearMonth).toBe("2026-05");
  });

  it("tx on Jan 2 links to December recurring (day 30 → window [Dec 20, Jan 4])", async () => {
    const accountId = await seedAccount();
    // Recurring fires on day 30. Jan 2 is within [Dec 20, Jan 4].
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink cross-month prev",
      amountCents: BigInt(-50000),
      dayOfMonth: 30,
    });
    // tx on Jan 2, 2026. Expected date for Dec 2025: Dec 30. Window: [Dec 20, Jan 4].
    const txId = await seedTx(accountId, {
      occurredOn: "2026-01-02",
      amountCents: BigInt(-50000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.yearMonth).toBe("2025-12");
      expect(result.recurringId).toBe(recurringId);
    }

    const [linked] = await db
      .select({ recurringYearMonth: transactions.recurringYearMonth })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringYearMonth).toBe("2025-12");
  });

  it("Feb 28 with day-30 recurring clamps to Feb 28 → match works (issue: clamp)", async () => {
    const accountId = await seedAccount();
    // Recurring fires on day 30. Feb 2026 has 28 days → clamped to Feb 28.
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink cross-month feb-clamp",
      amountCents: BigInt(-75000),
      dayOfMonth: 30,
    });
    // tx on Feb 28, 2026. Expected: Feb 28 (clamped). Window: [Feb 18, Mar 5].
    const txId = await seedTx(accountId, {
      occurredOn: "2026-02-28",
      amountCents: BigInt(-75000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.yearMonth).toBe("2026-02");
      expect(result.recurringId).toBe(recurringId);
    }
  });

  it("Dec 30 tx links to Jan next-year recurring (day 1, window [Dec 22, Jan 6])", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink cross-month dec30",
      amountCents: BigInt(-100000),
      dayOfMonth: 1,
    });
    // tx on Dec 30, 2025. Expected: Jan 1, 2026. Window: [Dec 22, Jan 6].
    const txId = await seedTx(accountId, {
      occurredOn: "2025-12-30",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.yearMonth).toBe("2026-01");
      expect(result.recurringId).toBe(recurringId);
    }

    const [linked] = await db
      .select({ recurringYearMonth: transactions.recurringYearMonth })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringYearMonth).toBe("2026-01");
  });

  it("multiple matches across months → ambiguous (no link)", async () => {
    const accountId = await seedAccount();
    // Two recurrings: day 30 (evaluates Jan window) and day 1 (evaluates Jan and Feb windows).
    // tx on Feb 1 2026 — day-30 recurring: Dec 30 window [Dec 20, Jan 4] NO. Jan 30 window [Jan 20, Feb 4] YES.
    // day-1 recurring: Jan 1 window [Dec 22, Jan 6] NO. Feb 1 window [Jan 22, Feb 6] YES.
    // → 2 matches across months → ambiguous.
    await seedRecurring(accountId, {
      label: "__autolink cross-month amb A",
      amountCents: BigInt(-100000),
      dayOfMonth: 30,
    });
    await seedRecurring(accountId, {
      label: "__autolink cross-month amb B",
      amountCents: BigInt(-100000),
      dayOfMonth: 1,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-02-01",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidateCount).toBe(2);
    }
    // Verify tx not linked
    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // #633: Description fingerprint fallback tests
  // ---------------------------------------------------------------------------

  it("#633: links via description fingerprint when amount differs", async () => {
    const accountId = await seedAccount();
    // Recurring estimated at -42000 but real payment is -44900.
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink_netflix_633__",
      amountCents: BigInt(-42000),
      dayOfMonth: 15,
    });

    // Seed a pattern with observation_count = 2 (unambiguous).
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "NETFLIX",
      observationCount: 2,
      patternAmbiguous: false,
    });

    // Tx on day 15 of the month, amount -44900 (doesn't match exact -42000).
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-44900),
      description: "NETFLIX*DL",
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);

    expect(result.status).toBe("linked");
    if (result.status !== "linked") throw new Error("should not reach");
    expect(result.recurringId).toBe(recurringId);
  });

  it("#633: does NOT link via description when pattern has observation_count < 2", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink_spotify_633__",
      amountCents: BigInt(-42000),
      dayOfMonth: 15,
    });

    // Pattern with observation_count = 1 — not enough signal.
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "SPOTIFY",
      observationCount: 1,
      patternAmbiguous: false,
    });

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-44900),
      description: "SPOTIFY P",
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");
  });

  it("#633: Google Play ambiguity — pattern matches 2 recurrings → no auto-link via description", async () => {
    const accountId = await seedAccount();
    const recurringYouTubeId = await seedRecurring(accountId, {
      label: "__autolink_gplay_yt_633__",
      amountCents: BigInt(-21900),
      dayOfMonth: 10,
    });
    const recurringGOneId = await seedRecurring(accountId, {
      label: "__autolink_gplay_gone_633__",
      amountCents: BigInt(-10900),
      dayOfMonth: 10,
    });

    // Both recurrings share the "GOOGLE" pattern.
    await db.insert(recurringDescriptionPatterns).values([
      {
        userId: TEST_USER_ID,
        recurringId: recurringYouTubeId,
        pattern: "GOOGLE",
        observationCount: 3,
        patternAmbiguous: true, // already flagged as ambiguous
      },
      {
        userId: TEST_USER_ID,
        recurringId: recurringGOneId,
        pattern: "GOOGLE",
        observationCount: 2,
        patternAmbiguous: true,
      },
    ]);

    // Tx with a completely different amount — won't match via amount.
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-19900),
      description: "GOOGLE *PLAY YOUTUBE",
    });

    // Should not auto-link via description since both patterns are ambiguous.
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");

    // Verify tx is not linked.
    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();
  });

  it("#633: amount-based match still works even when description is Google Play ambiguous", async () => {
    const accountId = await seedAccount();
    // Amount match takes precedence over description ambiguity.
    const recurringYouTubeId = await seedRecurring(accountId, {
      label: "__autolink_gplay_yt2_633__",
      amountCents: BigInt(-21900),
      dayOfMonth: 10,
    });

    // Ambiguous description pattern but amount is exact.
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId: recurringYouTubeId,
      pattern: "GOOGLE",
      observationCount: 3,
      patternAmbiguous: true,
    });

    // Tx with EXACT amount match — should link via amount path.
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-21900), // exact match
      description: "GOOGLE *PLAY YOUTUBE",
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);

    expect(result.status).toBe("linked");
    if (result.status !== "linked") throw new Error("should not reach");
    expect(result.recurringId).toBe(recurringYouTubeId);
  });
});
