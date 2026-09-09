import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringGaps,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import {
  closePreviousMonth,
  closePreviousMonthForAllUsers,
  detectGapsForMonth,
  previousYearMonth,
  reconcileOpenGaps,
} from "./gap-detector";

// ---------------------------------------------------------------------------
// emitNotification mock — shared across all test suites
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 999 }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

const TEST_ACCOUNT = "__gap_test_account__";

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_gaps WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__gap_test%')`,
  );
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__gap_test%'`);
  // Also catch #804 tests that seed a custom (non-'__gap_test%') description
  // on a dedicated test account — those transactions must be cleared before
  // the account FK delete below.
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${TEST_ACCOUNT + "%"})`,
  );
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE '__gap_test%'`);
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${TEST_ACCOUNT + "%"}`);
}

const TEST_USER_ID = 1;

async function seedAccount(nameSuffix = "", userId = TEST_USER_ID) {
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

  it("#804: late payment — tx 6 days after the old fixed +5 bound now auto-links", async () => {
    // Pre-#804 this was outside the fixed ±10/+5 window and created a gap.
    // #804 replaces the fixed window with slot-claiming, which explicitly
    // supports late payments — see src/lib/recurring/slot.ts.
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test late pay",
      amountCents: BigInt(-100000),
      dayOfMonth: 10,
    });
    // tx on apr-16 (6 days after day 10)
    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-16",
      amountCents: BigInt(-100000),
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(1);
    expect(result.gapsCreated).toBe(0);

    const [linked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recId);
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

describe("detectGapsForMonth #804 — cross-account and skip veto", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("auto-links a tx paid from a DIFFERENT account via the learned fingerprint", async () => {
    const accountA = await seedAccount("_A");
    const accountB = await seedAccount("_B");
    const recId = await seedRecurring(accountA, {
      label: "__gap_test crossaccount",
      amountCents: BigInt(-4490000),
      dayOfMonth: 15,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId: recId,
      pattern: "NETFLIX",
      observationCount: 2,
    });

    const txId = await seedTx(accountB, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-4490000),
      description: "NETFLIX*DL",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(1);
    expect(result.gapsCreated).toBe(0);

    const [linked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recId);
  });

  it("does NOT auto-link a same-amount purchase with an unmatched token, even cross-account", async () => {
    const accountA = await seedAccount("_A2");
    const accountB = await seedAccount("_B2");
    await seedRecurring(accountA, {
      label: "__gap_test appletv",
      amountCents: BigInt(-2990000),
      dayOfMonth: 15,
    });

    // No fingerprint learned yet; description has an extractable-but-unmatched
    // token ("KFC") — must not fall back to amount-only matching.
    await seedTx(accountB, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2990000),
      description: "KFC UNICENTRO MEDELL",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(1);
  });

  it("CRITICAL fix: KFC purchase byte-identical to Apple TV's amount does NOT auto-link even on Apple TV's OWN account", async () => {
    const accountId = await seedAccount("_sameacct");
    const recId = await seedRecurring(accountId, {
      label: "__gap_test appletv sameacct",
      amountCents: BigInt(-2990000),
      dayOfMonth: 15,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId: recId,
      pattern: "APPLE",
      observationCount: 2,
    });

    await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2990000),
      description: "KFC UNICENTRO MEDELL",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(1);
  });

  it("bootstrap preserved: classic match still links when the recurring has zero learned patterns", async () => {
    const accountId = await seedAccount("_bootstrap");
    const recId = await seedRecurring(accountId, {
      label: "__gap_test bootstrap",
      amountCents: BigInt(-3050000),
      dayOfMonth: 15,
    });

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-3050000),
      description: "SPOTIFY P 12345",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(1);

    const [linked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recId);
  });
});

// ---------------------------------------------------------------------------
// #804 NEW REQUIREMENT: bijective pairing for genuinely indistinguishable
// recurrings (the "Tigo Aida / Tigo Alejo" shape — same account, same
// amount, same learned token, no signal to tell them apart).
// ---------------------------------------------------------------------------
describe("detectGapsForMonth #804 — bijective assignment", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("two indistinguishable recurrings + two matching txs → both link, one each", async () => {
    const accountId = await seedAccount("_tigo");
    const recA = await seedRecurring(accountId, {
      label: "__gap_test tigo aida",
      amountCents: BigInt(-4790000),
      dayOfMonth: 5,
    });
    const recB = await seedRecurring(accountId, {
      label: "__gap_test tigo alejo",
      amountCents: BigInt(-4790000),
      dayOfMonth: 8,
    });
    await db.insert(recurringDescriptionPatterns).values([
      {
        userId: TEST_USER_ID,
        recurringId: recA,
        pattern: "UNE",
        observationCount: 2,
      },
      {
        userId: TEST_USER_ID,
        recurringId: recB,
        pattern: "UNE",
        observationCount: 2,
      },
    ]);

    const tx1 = await seedTx(accountId, {
      occurredOn: "2026-04-05",
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 1",
    });
    const tx2 = await seedTx(accountId, {
      occurredOn: "2026-04-08",
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 2",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(2);
    expect(result.gapsCreated).toBe(0);

    const [row1] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx1));
    const [row2] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx2));

    // Both linked, each to a DIFFERENT recurring (bijective, no double-claim).
    expect(row1.recurringId).not.toBeNull();
    expect(row2.recurringId).not.toBeNull();
    expect(row1.recurringId).not.toBe(row2.recurringId);
    expect(new Set([row1.recurringId, row2.recurringId])).toEqual(new Set([recA, recB]));
  });

  it("BOOTSTRAP fix: two indistinguishable recurrings with ZERO learned patterns + two matching txs → both link (first month they coexist)", async () => {
    // Regression for the bootstrap inconsistency: an empty shared pattern
    // set must mean "nothing to contradict" (pass through), matching the
    // single-classic semantics in resolveTxWinner()/auto-link.ts's
    // resolveCandidate() — NOT "nothing matches" (which would silently skip
    // bijective pairing on the very first month two such recurrings exist).
    const accountId = await seedAccount("_tigo_bootstrap");
    const recA = await seedRecurring(accountId, {
      label: "__gap_test tigo bootstrap a",
      amountCents: BigInt(-4790000),
      dayOfMonth: 5,
    });
    const recB = await seedRecurring(accountId, {
      label: "__gap_test tigo bootstrap b",
      amountCents: BigInt(-4790000),
      dayOfMonth: 8,
    });
    // No recurringDescriptionPatterns rows at all — zero learned patterns.

    const tx1 = await seedTx(accountId, {
      occurredOn: "2026-04-05",
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 1",
    });
    const tx2 = await seedTx(accountId, {
      occurredOn: "2026-04-08",
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 2",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(2);
    expect(result.gapsCreated).toBe(0);

    const [row1] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx1));
    const [row2] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx2));

    expect(row1.recurringId).not.toBeNull();
    expect(row2.recurringId).not.toBeNull();
    expect(row1.recurringId).not.toBe(row2.recurringId);
    expect(new Set([row1.recurringId, row2.recurringId])).toEqual(new Set([recA, recB]));
  });

  it("deterministic tie-break: two txs with IDENTICAL occurredAt still pair up bijectively without error", async () => {
    // Two candidate txs at the exact same timestamp (plausible with
    // date-only precision on CSV/SMS imports) must still resolve
    // deterministically via the transactions.id secondary sort key, not
    // unspecified Postgres row order.
    const accountId = await seedAccount("_tigo_tie");
    const recA = await seedRecurring(accountId, {
      label: "__gap_test tigo tie a",
      amountCents: BigInt(-4790000),
      dayOfMonth: 5,
    });
    const recB = await seedRecurring(accountId, {
      label: "__gap_test tigo tie b",
      amountCents: BigInt(-4790000),
      dayOfMonth: 8,
    });
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: recA, pattern: "UNE", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: recB, pattern: "UNE", observationCount: 2 },
    ]);

    const sameTimestamp = "2026-04-05";
    const tx1 = await seedTx(accountId, {
      occurredOn: sameTimestamp,
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 1",
    });
    const tx2 = await seedTx(accountId, {
      occurredOn: sameTimestamp,
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 2",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(2);
    expect(result.gapsCreated).toBe(0);

    const [row1] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx1));
    const [row2] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx2));

    // Lower tx id (tx1) pairs with the earlier-dayOfMonth recurring (recA) —
    // deterministic per the id-ascending tie-break.
    expect(row1.recurringId).toBe(recA);
    expect(row2.recurringId).toBe(recB);
  });

  it("two indistinguishable occurrences but only ONE matching tx → exactly one links, the other becomes a gap", async () => {
    const accountId = await seedAccount("_tigo_partial");
    const recA = await seedRecurring(accountId, {
      label: "__gap_test tigo partial a",
      amountCents: BigInt(-4790000),
      dayOfMonth: 5,
    });
    const recB = await seedRecurring(accountId, {
      label: "__gap_test tigo partial b",
      amountCents: BigInt(-4790000),
      dayOfMonth: 8,
    });
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: recA, pattern: "UNE", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: recB, pattern: "UNE", observationCount: 2 },
    ]);

    const txId = await seedTx(accountId, {
      occurredOn: "2026-04-05",
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(1);
    expect(result.gapsCreated).toBe(1);

    // Never double-claimed — only one recurring got the tx.
    const linkedCount = await db.execute<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM transactions WHERE id = ${txId} AND recurring_id IS NOT NULL`,
    );
    expect(linkedCount[0]?.c).toBe("1");
  });

  it("a skipped month is never claimed by bijective pairing", async () => {
    const accountId = await seedAccount("_tigo_skip");
    const recA = await seedRecurring(accountId, {
      label: "__gap_test tigo skip a",
      amountCents: BigInt(-4790000),
      dayOfMonth: 5,
      skippedMonths: ["2026-04"],
    });
    const recB = await seedRecurring(accountId, {
      label: "__gap_test tigo skip b",
      amountCents: BigInt(-4790000),
      dayOfMonth: 8,
    });
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: recA, pattern: "UNE", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: recB, pattern: "UNE", observationCount: 2 },
    ]);

    const tx1 = await seedTx(accountId, {
      occurredOn: "2026-04-05",
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 1",
    });
    const tx2 = await seedTx(accountId, {
      occurredOn: "2026-04-08",
      amountCents: BigInt(-4790000),
      description: "UNE*TIGO PAGO 2",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    // recA is skipped -> excluded before grouping -> only recB is eligible ->
    // group size 1 -> no bijective pairing -> resolved individually against
    // BOTH candidate txs -> genuinely ambiguous (2 txs, 1 recurring, same
    // token+amount+account) -> gap created for recB, recA untouched.
    expect(result.skippedIntentionally).toBe(1);
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(1);

    const [row1] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx1));
    const [row2] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, tx2));
    // Neither tx was ever assigned to the SKIPPED recurring — the strongest,
    // most important guarantee here.
    expect(row1.recurringId).not.toBe(recA);
    expect(row2.recurringId).not.toBe(recA);
    // And since it's genuinely ambiguous (no bijective help for a lone
    // recurring), neither tx was linked at all yet.
    expect(row1.recurringId).toBeNull();
    expect(row2.recurringId).toBeNull();
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

describe("recurring_gap_detected notification emit", () => {
  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
  });
  afterEach(cleanup);

  it("fires emitNotification once when a new gap is created", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test notify",
      amountCents: BigInt(-150000),
      dayOfMonth: 5,
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.gapsCreated).toBe(1);

    // Allow the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.emitNotification).toHaveBeenCalledTimes(1);

    const [calledUserId, calledInput] = mocks.emitNotification.mock.calls[0]!;
    expect(calledUserId).toBe(TEST_USER_ID);

    // Retrieve the gap id inserted so we can verify entityId
    const gaps = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(eq(recurringGaps.yearMonth, "2026-04"));
    const gapId = gaps[0]!.id;

    expect(calledInput).toMatchObject({
      type: "recurring_gap_detected",
      entityId: String(gapId),
      priority: "medium",
    });
  });

  it("does NOT fire emitNotification when the gap already exists (idempotent re-run)", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test notify idem",
      amountCents: BigInt(-150000),
      dayOfMonth: 5,
    });

    // First run — creates the gap and should emit
    await detectGapsForMonth(TEST_USER_ID, "2026-04");
    await new Promise((r) => setTimeout(r, 0));
    mocks.emitNotification.mockClear();

    // Second run — gap already exists (ON CONFLICT DO NOTHING returns empty)
    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.gapsAlreadyOpen).toBe(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire emitNotification when the tx is auto-linked (no gap path taken)", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test notify autolink",
      amountCents: BigInt(-200000),
      dayOfMonth: 10,
    });
    await seedTx(accountId, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-200000),
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(1);
    expect(result.gapsCreated).toBe(0);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire emitNotification when the month is intentionally skipped", async () => {
    const accountId = await seedAccount();
    await seedRecurring(accountId, {
      label: "__gap_test notify skip",
      amountCents: BigInt(-49000),
      dayOfMonth: 10,
      skippedMonths: ["2026-04"],
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.skippedIntentionally).toBe(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });
});

describe("detectGapsForMonth / reconcileOpenGaps #844", () => {
  const OTHER_EMAIL = "__gap_test_844_user2@example.com";

  async function cleanup844() {
    await cleanup();
    await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_EMAIL}`);
  }

  beforeEach(cleanup844);
  afterEach(cleanup844);

  async function seedOpenGap(recurringId: number, yearMonth: string, userId = TEST_USER_ID) {
    const [g] = await db
      .insert(recurringGaps)
      .values({ userId, recurringId, yearMonth })
      .returning({ id: recurringGaps.id });
    return g.id;
  }

  it("when a gap already exists for a month that contains a matching tx, links the tx and deletes the gap", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test 844 preexisting",
      amountCents: BigInt(-508300),
      dayOfMonth: 1,
    });
    await seedOpenGap(recId, "2026-07");
    const txId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: BigInt(-508300),
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBeGreaterThanOrEqual(1);

    const [linked] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recId);
    expect(linked.recurringYearMonth).toBe("2026-07");

    const leftover = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recId), eq(recurringGaps.yearMonth, "2026-07")));
    expect(leftover).toHaveLength(0);
  });

  it("does not delete an unmatched still-open gap", async () => {
    const accountId = await seedAccount();
    const recLinked = await seedRecurring(accountId, {
      label: "__gap_test 844 survive linked",
      amountCents: BigInt(-49_910_000),
      dayOfMonth: 1,
    });
    const recOpen = await seedRecurring(accountId, {
      label: "__gap_test 844 survive open",
      amountCents: BigInt(-50_830_000),
      dayOfMonth: 1,
    });
    await seedTx(accountId, {
      occurredOn: "2026-07-03",
      amountCents: BigInt(-49_910_000),
      recurringId: recLinked,
      recurringYearMonth: "2026-07",
    });
    await seedOpenGap(recLinked, "2026-07");
    await seedOpenGap(recOpen, "2026-07");

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.existingLinks).toBeGreaterThanOrEqual(1);

    const linkedGap = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recLinked), eq(recurringGaps.yearMonth, "2026-07")));
    expect(linkedGap).toHaveLength(0);

    const stillOpen = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recOpen), eq(recurringGaps.yearMonth, "2026-07")));
    expect(stillOpen).toHaveLength(1);
  });

  it("deletes a leftover open gap when the occurrence is already linked", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test 844 stale",
      amountCents: BigInt(-499100),
      dayOfMonth: 1,
    });
    await seedTx(accountId, {
      occurredOn: "2026-07-03",
      amountCents: BigInt(-499100),
      recurringId: recId,
      recurringYearMonth: "2026-07",
    });
    await seedOpenGap(recId, "2026-07");

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.existingLinks).toBeGreaterThanOrEqual(1);

    const leftover = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recId), eq(recurringGaps.yearMonth, "2026-07")));
    expect(leftover).toHaveLength(0);
  });

  it("reconcileOpenGaps links an orphaned tx against an older open gap without creating new gaps", async () => {
    // Decoy (same account, different amount) and a second user with the same
    // amount must both survive. A matcher that ignored amount or user_id
    // would steal one of those.
    const accountId = await seedAccount();
    const recMatch = await seedRecurring(accountId, {
      label: "__gap_test 844 reconcile match",
      amountCents: BigInt(-50_830_000),
      dayOfMonth: 1,
    });
    const recDecoy = await seedRecurring(accountId, {
      label: "__gap_test 844 reconcile decoy",
      amountCents: BigInt(-49_910_000),
      dayOfMonth: 1,
    });
    await seedOpenGap(recMatch, "2026-07");
    await seedOpenGap(recDecoy, "2026-07");
    const txId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: BigInt(-50_830_000),
      description: "APORTES EN LINEA",
    });

    const [otherUser] = await db
      .insert(users)
      .values({ email: OTHER_EMAIL, name: "Gap 844 Other User" })
      .returning({ id: users.id });
    const otherAccount = await seedAccount("_u2", otherUser.id);
    const recOther = await seedRecurring(otherAccount, {
      label: "__gap_test 844 reconcile other",
      amountCents: BigInt(-50_830_000),
      dayOfMonth: 1,
      userId: otherUser.id,
    });
    await seedOpenGap(recOther, "2026-07", otherUser.id);
    const otherTx = await seedTx(otherAccount, {
      occurredOn: "2026-07-19",
      amountCents: BigInt(-50_830_000),
      description: "APORTES EN LINEA",
      userId: otherUser.id,
    });

    const result = await reconcileOpenGaps(TEST_USER_ID);
    expect(result.autoLinked).toBeGreaterThanOrEqual(1);

    const [linked] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recMatch);
    expect(linked.recurringYearMonth).toBe("2026-07");

    const matchGap = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recMatch), eq(recurringGaps.yearMonth, "2026-07")));
    expect(matchGap).toHaveLength(0);

    const decoyGap = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recDecoy), eq(recurringGaps.yearMonth, "2026-07")));
    expect(decoyGap).toHaveLength(1);

    const otherGap = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recOther), eq(recurringGaps.yearMonth, "2026-07")));
    expect(otherGap).toHaveLength(1);

    const [otherLinked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, otherTx));
    expect(otherLinked.recurringId).toBeNull();
  });

  it("closePreviousMonth also reconciles older open gaps, not just M-1", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test 844 cron sweep",
      amountCents: BigInt(-499100),
      dayOfMonth: 1,
    });
    await seedOpenGap(recId, "2026-07");
    const txId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: BigInt(-499100),
    });

    // today = 2026-09-05 → detectGapsForMonth closes 2026-08, then
    // reconcileOpenGaps must still pick up the July orphan.
    const closed = await closePreviousMonth(TEST_USER_ID, new Date("2026-09-05T12:00:00Z"));
    expect(closed.yearMonth).toBe("2026-08");

    const [linked] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recId);
    expect(linked.recurringYearMonth).toBe("2026-07");

    const julyGap = await db
      .select({ id: recurringGaps.id })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recId), eq(recurringGaps.yearMonth, "2026-07")));
    expect(julyGap).toHaveLength(0);
  });

  it("unique learned token links a utility bill whose amount differs every month", async () => {
    const accountId = await seedAccount();
    const recId = await seedRecurring(accountId, {
      label: "__gap_test 844 epm",
      amountCents: BigInt(-490000),
      dayOfMonth: 15,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId: recId,
      pattern: "EMPRESAS",
      observationCount: 3,
    });
    const txId = await seedTx(accountId, {
      occurredOn: "2026-08-20",
      amountCents: BigInt(-594594),
      description: "EMPRESAS PUBLICAS DE MEDELLIN",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-08");
    expect(result.autoLinked).toBeGreaterThanOrEqual(1);

    const [linked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(linked.recurringId).toBe(recId);
  });
});

// ---------------------------------------------------------------------------
// #857: drifted amount + shared fingerprint. Aida/Alejo Seguridad Social.
// Recurring 9 is ALWAYS seeded first (lower id) — the drifted twin — so
// insert order / lowest-id cannot silently carry a passing result.
// ---------------------------------------------------------------------------
describe("detectGapsForMonth #857 — drifted amount with shared fingerprint", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const AIDA = BigInt(-49910000);
  const ALEJO = BigInt(-50830000);
  const DRIFT_AIDA = BigInt(-50110000); // 0.40% off Aida, 1.42% off Alejo
  const OVERLAP = BigInt(-50350000); // 0.88% off Aida, 0.94% off Alejo — both inside 1%
  const DESC = "Pago a APORTES EN LINEA";

  async function seedAportesTwins(accountSuffix: string) {
    const accountId = await seedAccount(accountSuffix);
    const aidaId = await seedRecurring(accountId, {
      label: "__gap_test aportes aida",
      amountCents: AIDA,
      dayOfMonth: 1,
    });
    const alejoId = await seedRecurring(accountId, {
      label: "__gap_test aportes alejo",
      amountCents: ALEJO,
      dayOfMonth: 1,
    });
    expect(aidaId).toBeLessThan(alejoId);
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: aidaId, pattern: "PAGO", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: alejoId, pattern: "PAGO", observationCount: 2 },
    ]);
    return { accountId, aidaId, alejoId };
  }

  it("prod replica: exact Alejo + 0.4% Aida drift both link, even when Aida has the lower id and the exact tx has the lower id", async () => {
    // Zip-by-lowest-id would pair exact→Aida and drift→Alejo (both wrong).
    // Current main (Aida processed first, token collision, no exact) leaves
    // the drift unlinked. Either failure mode must fail this test.
    const { accountId, aidaId, alejoId } = await seedAportesTwins("_857_prod");
    const exactTxId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: ALEJO,
      description: DESC,
    });
    const driftTxId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: DRIFT_AIDA,
      description: DESC,
    });
    expect(exactTxId).toBeLessThan(driftTxId);

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(2);
    expect(result.gapsCreated).toBe(0);

    const [exactRow] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, exactTxId));
    const [driftRow] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, driftTxId));
    expect(exactRow.recurringId).toBe(alejoId);
    expect(driftRow.recurringId).toBe(aidaId);
  });

  it("a tx within 1% of two still-available recurrings does NOT auto-link", async () => {
    // Lowest-id and nearest both pick Aida. Ambiguity must still abstain.
    // If unique-token in the per-recurring loop stole it for Aida (lowest
    // id, processed first), this assertion fails.
    const { accountId, aidaId, alejoId } = await seedAportesTwins("_857_amb");
    const txId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: OVERLAP,
      description: DESC,
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(2);

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();

    const gaps = await db
      .select({ recurringId: recurringGaps.recurringId })
      .from(recurringGaps)
      .where(eq(recurringGaps.userId, TEST_USER_ID));
    const gapRecurringIds = new Set(gaps.map((g) => g.recurringId));
    expect(gapRecurringIds).toEqual(new Set([aidaId, alejoId]));
  });

  it("exact-first then leftover: an overlap-zone tx links to Aida only AFTER Alejo consumes the exact match", async () => {
    // Without exact-first the overlap tx is within 1% of BOTH, so we abstain
    // and Aida stays a gap. Exact-first consumes Alejo; the leftover is then
    // uniquely Aida's. Zip-by-id would assign the exact tx to Aida (wrong).
    const { accountId, aidaId, alejoId } = await seedAportesTwins("_857_exactfirst");
    const exactTxId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: ALEJO,
      description: DESC,
    });
    const overlapTxId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: OVERLAP,
      description: DESC,
    });
    expect(exactTxId).toBeLessThan(overlapTxId);

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(2);
    expect(result.gapsCreated).toBe(0);

    const [exactRow] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, exactTxId));
    const [overlapRow] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, overlapTxId));
    expect(exactRow.recurringId).toBe(alejoId);
    expect(overlapRow.recurringId).toBe(aidaId);
  });

  it("does not near-match a 0.4% drift whose token contradicts the learned fingerprint", async () => {
    const accountId = await seedAccount("_857_kfc");
    const recId = await seedRecurring(accountId, {
      label: "__gap_test appletv drift",
      amountCents: BigInt(-2990000),
      dayOfMonth: 1,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId: recId,
      pattern: "APPLE",
      observationCount: 2,
    });
    await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: BigInt(-3002000), // 0.40% off
      description: "KFC UNICENTRO MEDELL",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(1);
  });
});

// Keep the `and` import live — drizzle barrel exports trip tree-shakers.
void and;
