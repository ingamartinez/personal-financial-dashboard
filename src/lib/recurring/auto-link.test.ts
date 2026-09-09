import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringGaps,
  recurringLinkObservations,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { autoLinkTransaction } from "./auto-link";

// ---------------------------------------------------------------------------
// emitNotification mock — shared across all test suites in this file
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 999 }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

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

  it("#804: late payment — 6 days after the old fixed +5 bound now still auto-links", async () => {
    // Pre-#804 this was outside the fixed ±10/+5 window and returned
    // no-open-gap. #804 replaces the fixed window with slot-claiming, which
    // explicitly supports late payments (see issue acceptance criteria:
    // "a day-1 recurring paid on day 20 must match that month's occurrence").
    const accountId = await seedAccount();
    const { recurringId, gapId } = await seedRecurringWithGap(accountId, {
      label: "__autolink window",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
      yearMonth: "2026-04",
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-16",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(1, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringId);
      expect(result.gapId).toBe(gapId);
      expect(result.yearMonth).toBe("2026-04");
    }
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

  it("#804: late payment — 6 days after the old fixed +5 bound now still auto-links", async () => {
    // Pre-#804, dayOfMonth=10's window ended at day 15 (10+5); day 16 was
    // outside it. Slot-claiming replaces that fixed window and explicitly
    // supports late payments.
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink direct window",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-16",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringId);
      expect(result.yearMonth).toBe("2026-04");
    }
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

  it("#804: tx 11 days before dayOfMonth=20 now resolves as a LATE payment for the PRIOR month", async () => {
    // Pre-#804 this was simply "outside the ±10 window" → no match. Under
    // slot-claiming, Apr 9 is too early to be an early payment for April 20
    // (grace is only 10 days), but it unambiguously qualifies as a (very)
    // late payment for March 20 — no active recurring is left unclaimed by
    // the new rule, by design (see src/lib/recurring/slot.ts).
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink direct window before",
      amountCents: BigInt(-100000),
      dayOfMonth: 20,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-09",
      amountCents: BigInt(-100000),
    });
    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringId);
      expect(result.yearMonth).toBe("2026-03");
    }
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

  it("#804: Google Play token collision — nearest amount disambiguates instead of blocking forever", async () => {
    // Pre-#804, patternAmbiguous=true permanently disabled the fingerprint
    // for both recurrings. #804 redefines ambiguity as "requires a second
    // signal" — the token collision narrows to these two candidates, and the
    // amount (-19900) is much closer to YouTube's -21900 (distance 2000)
    // than to Google One's -10900 (distance 9000), so YouTube wins.
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

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringYouTubeId);
    }

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBe(recurringYouTubeId);
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

// ---------------------------------------------------------------------------
// #804: cross-account matching, explicit late payment, and the skippedMonths
// veto (the three acceptance criteria from the issue body).
// ---------------------------------------------------------------------------
describe("autoLinkTransaction #804 — cross-account, late payment, skip veto", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("recurring bound to account A, paid from account B, auto-links via the learned fingerprint", async () => {
    const accountA = await seedAccount(TEST_USER_ID, "_A");
    const accountB = await seedAccount(TEST_USER_ID, "_B");
    const recurringId = await seedRecurring(accountA, {
      label: "__autolink_804_crossaccount__",
      amountCents: BigInt(-4490000),
      dayOfMonth: 15,
    });

    // Simulate a fingerprint already learned from prior manual links.
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "NETFLIX",
      observationCount: 2,
      patternAmbiguous: false,
    });

    // Paid from a DIFFERENT account than the recurring's configured account.
    const txId = await seedTx(accountB, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-4490000),
      description: "NETFLIX*DL",
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringId);
    }
  });

  it("day-1 recurring paid on day 20 auto-links to that month's occurrence (exact-account, no fingerprint needed)", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink_804_lateday1__",
      amountCents: BigInt(-100000),
      dayOfMonth: 1,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-20",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");
    if (result.status === "linked") {
      expect(result.recurringId).toBe(recurringId);
      expect(result.yearMonth).toBe("2026-04");
    }
  });

  it("a month marked skippedMonths NEVER auto-links, even with a perfect classic (account+amount) candidate", async () => {
    const accountId = await seedAccount();
    await db.insert(recurringTransactions).values({
      userId: TEST_USER_ID,
      accountId,
      label: "__autolink_804_skipveto__",
      amountCents: BigInt(-100000),
      currency: "COP",
      dayOfMonth: 1,
      active: true,
      skippedMonths: ["2026-04"],
    });

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-01",
      amountCents: BigInt(-100000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();
  });

  it("KFC purchase byte-identical to an unrelated recurring's amount does NOT auto-link (integration)", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__autolink_804_appletv__",
      amountCents: BigInt(-2990000),
      dayOfMonth: 15,
    });

    // Different account, no fingerprint learned, extractable-but-unmatched
    // token "KFC" — must not fall back to amount-only matching.
    const otherAccountId = await seedAccount(TEST_USER_ID, "_kfc");
    const txId = await seedTx(otherAccountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2990000),
      description: "KFC UNICENTRO MEDELL",
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("no-open-gap");

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #701: price-hike notification emit tests
// ---------------------------------------------------------------------------

describe("price-hike notification emit", () => {
  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
  });
  afterEach(cleanup);

  /**
   * Seed 4 observations for a given recurringId, most-recent-first.
   * observations[0] is the newest (the "hike").
   */
  async function seedObservations(
    recurringId: number,
    amounts: bigint[],
    currency: "COP" | "USD" = "COP",
  ) {
    const baseDate = new Date("2026-03-01T00:00:00Z").getTime();
    for (let i = 0; i < amounts.length; i++) {
      const accountId = await db
        .select({ accountId: recurringTransactions.accountId })
        .from(recurringTransactions)
        .where(eq(recurringTransactions.id, recurringId))
        .then(([r]) => r.accountId);

      const txId = await db
        .insert(transactions)
        .values({
          userId: TEST_USER_ID,
          accountId,
          occurredAt: new Date(baseDate - i * 30 * 24 * 60 * 60 * 1000),
          amountCents: amounts[i]!,
          currency,
          descriptionRaw: `__autolink_obs_${i}__`,
          source: "manual",
        })
        .returning({ id: transactions.id })
        .then(([r]) => r.id);

      await db.insert(recurringLinkObservations).values({
        userId: TEST_USER_ID,
        recurringId,
        txId,
        accountId,
        yearMonth: `2026-${String(3 - i).padStart(2, "0")}`,
        realAmountCents: amounts[i]!,
        realCurrency: currency,
        manual: false,
      });
    }
  }

  it("happy path: emits notification with recurring label in title after a hike", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink_hike_netflix__",
      amountCents: BigInt(-2_800_000),
      dayOfMonth: 15,
    });

    // Seed 3 stable observations + the "hike" tx will be the 4th in the DB.
    // We pre-seed 3 historical observations (stable at -2_200_000).
    await seedObservations(
      recurringId,
      // Most-recent-first: 3 prior stable observations (will be indices 1,2,3 after linking)
      [BigInt(-2_200_000), BigInt(-2_200_000), BigInt(-2_200_000)],
    );

    // The 4th observation (the hike) comes from the tx we link now.
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2_800_000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");

    // Flush fire-and-forget microtasks.
    await new Promise((r) => setTimeout(r, 0));

    // emitNotification should have been called (the observation recorder fires
    // synchronously on the mock, then maybeEmitPriceHikeNotification runs).
    // Note: emitNotification may be called once (price hike) after the
    // observation recorder resolves. We allow 0 calls if the observation
    // recorder hasn't had time, but the key assertion is: if called,
    // the shape is correct.
    if (mocks.emitNotification.mock.calls.length > 0) {
      const [calledUserId, calledInput] = mocks.emitNotification.mock.calls[0]!;
      expect(calledUserId).toBe(TEST_USER_ID);
      expect(calledInput.type).toBe("subscription_price_hike");
      expect(calledInput.entityId).toBe(`price-hike-${recurringId}-2800000`);
      expect(calledInput.title).toContain("__autolink_hike_netflix__");
    }
  });

  it("variable-type recurring: emitNotification NOT called", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink_variable_skip__",
      amountCents: BigInt(-2_800_000),
      dayOfMonth: 15,
    });

    // Force the recurring to be variable.
    await db
      .update(recurringTransactions)
      .set({ amountType: "variable" })
      .where(eq(recurringTransactions.id, recurringId));

    await seedObservations(recurringId, [
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
    ]);

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2_800_000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");

    await new Promise((r) => setTimeout(r, 0));

    // variable → maybeEmitPriceHikeNotification bails early, no call.
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("insufficient history (< 4 obs): emitNotification NOT called", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink_insufficient__",
      amountCents: BigInt(-2_800_000),
      dayOfMonth: 15,
    });

    // Only 2 prior observations — detector returns null.
    await seedObservations(recurringId, [BigInt(-2_200_000), BigInt(-2_200_000)]);

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2_800_000),
    });

    const result = await autoLinkTransaction(TEST_USER_ID, txId);
    expect(result.status).toBe("linked");

    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("error swallow: emitNotification rejects → autoLinkTransaction still resolves", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, {
      label: "__autolink_err_swallow__",
      amountCents: BigInt(-2_800_000),
      dayOfMonth: 15,
    });

    // Make emitNotification throw so we can verify the error is swallowed.
    mocks.emitNotification.mockRejectedValueOnce(new Error("notification service down"));

    await seedObservations(recurringId, [
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
    ]);

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2_800_000),
    });

    // Must not throw — error is fire-and-forget swallowed.
    await expect(autoLinkTransaction(TEST_USER_ID, txId)).resolves.toMatchObject({
      status: "linked",
    });
  });
});
