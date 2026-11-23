import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
import {
  assignRelaxedTwins,
  closePreviousMonth,
  closePreviousMonthForAllUsers,
  detectGapsForMonth,
  previousYearMonth,
  reconcileOpenGaps,
  type RelaxedTwinGroup,
  type RelaxedTxCandidate,
  type ToProcessRow,
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
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
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
      { userId: TEST_USER_ID, recurringId: aidaId, pattern: "APORTES", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: alejoId, pattern: "APORTES", observationCount: 2 },
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

  it("twins 0.5% apart: a 0.40% drift sits in both 1% balls and still does NOT auto-link", async () => {
    // Spacing is not the invariant. Without blockedTxIds / degree>=2
    // abstain, detectGapsForMonth links the tx to closerId (lower id,
    // seeded first) and this test fails.
    const accountId = await seedAccount("_857_close");
    const closerId = await seedRecurring(accountId, {
      label: "__gap_test close twin a",
      amountCents: BigInt(-10050000),
      dayOfMonth: 1,
    });
    const fartherId = await seedRecurring(accountId, {
      label: "__gap_test close twin b",
      amountCents: BigInt(-10000000),
      dayOfMonth: 1,
    });
    expect(closerId).toBeLessThan(fartherId);
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: closerId, pattern: "APORTES", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: fartherId, pattern: "APORTES", observationCount: 2 },
    ]);
    const txId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: BigInt(-10040000),
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

  it("closePreviousMonth does not unique-token-steal a tx blocked as ambiguous", async () => {
    // detectGapsForMonth abstains and opens two gaps; reconcileOpenGaps then
    // runs. Without blockedTxIds on that pass, pickTxForRecurring's unique-token
    // path links the overlap tx to Aida (lower id) and this test fails.
    const { accountId, aidaId, alejoId } = await seedAportesTwins("_857_cron_steal");
    const txId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: OVERLAP,
      description: DESC,
    });

    await closePreviousMonth(TEST_USER_ID, new Date("2026-08-05T12:00:00Z"));

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();

    const gaps = await db
      .select({ recurringId: recurringGaps.recurringId })
      .from(recurringGaps)
      .where(eq(recurringGaps.userId, TEST_USER_ID));
    expect(new Set(gaps.map((g) => g.recurringId))).toEqual(new Set([aidaId, alejoId]));
  });

  it("reconcileOpenGaps does not unique-token-steal an overlap tx against older open gaps", async () => {
    // Pre-seeded July gaps; detectGapsForMonth is not run for July. Threading
    // blockedTxIds only from the latest detectGapsForMonth would miss this —
    // the blocked set has to be computed here. Without it, unique-token
    // links to Aida (lower id) and this test fails.
    const { accountId, aidaId, alejoId } = await seedAportesTwins("_857_recon_steal");
    await db.insert(recurringGaps).values([
      { userId: TEST_USER_ID, recurringId: aidaId, yearMonth: "2026-07" },
      { userId: TEST_USER_ID, recurringId: alejoId, yearMonth: "2026-07" },
    ]);
    const txId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: OVERLAP,
      description: DESC,
    });

    const result = await reconcileOpenGaps(TEST_USER_ID);
    expect(result.autoLinked).toBe(0);

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row.recurringId).toBeNull();

    const gaps = await db
      .select({ recurringId: recurringGaps.recurringId })
      .from(recurringGaps)
      .where(eq(recurringGaps.userId, TEST_USER_ID));
    expect(new Set(gaps.map((g) => g.recurringId))).toEqual(new Set([aidaId, alejoId]));
  });

  it("verb-stripped unique EMPRESAS does not unique-token-steal an APORTES overlap", async () => {
    // #852: stripping PAGO makes EMPRESAS unique. That must not give EPM
    // a back door into an APORTES overlap, and must not let unique-token
    // on APORTES (now the shared merchant token, not PAGO) steal for Aida.
    const { accountId, aidaId, alejoId } = await seedAportesTwins("_852_epm_pool");
    const epmId = await seedRecurring(accountId, {
      label: "__gap_test aportes epm",
      amountCents: BigInt(-49000000),
      dayOfMonth: 15,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId: epmId,
      pattern: "EMPRESAS",
      observationCount: 2,
    });
    const overlapTxId = await seedTx(accountId, {
      occurredOn: "2026-07-19",
      amountCents: OVERLAP,
      description: DESC,
    });
    const epmTxId = await seedTx(accountId, {
      occurredOn: "2026-07-20",
      amountCents: BigInt(-59459400),
      description: "Pago a EMPRESAS PUBLICAS DE MEDELLIN",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(1);

    const [overlapRow] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, overlapTxId));
    expect(overlapRow.recurringId).toBeNull();

    const [epmRow] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, epmTxId));
    expect(epmRow.recurringId).toBe(epmId);

    const gaps = await db
      .select({ recurringId: recurringGaps.recurringId })
      .from(recurringGaps)
      .where(eq(recurringGaps.userId, TEST_USER_ID));
    expect(new Set(gaps.map((g) => g.recurringId))).toEqual(new Set([aidaId, alejoId]));
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

describe("detectGapsForMonth #873 — proven-sibling cross-account", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const RENT_AMOUNT = BigInt(-230000000);
  const RENT_DESCRIPTION = "Transferencia a cuenta *138076518";

  it("auto-links a cross-account rent tx from an amount-consistent sibling observation", async () => {
    const arq = await seedAccount("_873_arq");
    const bancolombia = await seedAccount("_873_banco");
    const rentId = await seedRecurring(arq, {
      label: "__gap_test 873 rent",
      amountCents: RENT_AMOUNT,
      dayOfMonth: 1,
    });

    const juneTx = await seedTx(bancolombia, {
      occurredOn: "2026-06-05",
      amountCents: RENT_AMOUNT,
      description: RENT_DESCRIPTION,
      recurringId: rentId,
      recurringYearMonth: "2026-06",
    });
    await db.insert(recurringLinkObservations).values({
      userId: TEST_USER_ID,
      recurringId: rentId,
      txId: juneTx,
      yearMonth: "2026-06",
      realAmountCents: RENT_AMOUNT,
      realCurrency: "COP",
      descriptionRaw: RENT_DESCRIPTION,
      accountId: bancolombia,
      manual: true,
    });
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: rentId, pattern: "COLMEDICA", observationCount: 1 },
      { userId: TEST_USER_ID, recurringId: rentId, pattern: "TRANSFERENCIA", observationCount: 1 },
    ]);

    const julyTx = await seedTx(bancolombia, {
      occurredOn: "2026-07-07",
      amountCents: RENT_AMOUNT,
      description: RENT_DESCRIPTION,
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(1);
    expect(result.gapsCreated).toBe(0);

    const [linked] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, julyTx));
    expect(linked.recurringId).toBe(rentId);
  });

  it("does not steal a Colmedica tx onto rent via a count-1 COLMEDICA fingerprint", async () => {
    const arq = await seedAccount("_873_arq2");
    const rentId = await seedRecurring(arq, {
      label: "__gap_test 873 nocolmedica",
      amountCents: RENT_AMOUNT,
      dayOfMonth: 1,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId: rentId,
      pattern: "COLMEDICA",
      observationCount: 1,
    });
    await seedTx(arq, {
      occurredOn: "2026-07-07",
      amountCents: BigInt(-1170200),
      description: "COLMEDICA PREPAGADA",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(1);
  });

  it("does not link either of two cross-account recurrings that share amount and a generic sibling token", async () => {
    // Mirrors auto-link.test.ts's two-recurring single-charge shape, but the
    // proven-sibling path must NOT pick a winner: TRANSFERENCIA is generic
    // ("Transferencia a cuenta *XXXX") and both leftover recurrings own it.
    // Bijective/exact-near group by accountId, so they cannot see this.
    const arq = await seedAccount("_873_amb_arq");
    const other = await seedAccount("_873_amb_other");
    const bancolombia = await seedAccount("_873_amb_banco");
    const recA = await seedRecurring(arq, {
      label: "__gap_test 873 amb A",
      amountCents: RENT_AMOUNT,
      dayOfMonth: 1,
    });
    const recB = await seedRecurring(other, {
      label: "__gap_test 873 amb B",
      amountCents: RENT_AMOUNT,
      dayOfMonth: 1,
    });

    const juneA = await seedTx(bancolombia, {
      occurredOn: "2026-06-05",
      amountCents: RENT_AMOUNT,
      description: "Transferencia a cuenta *111111111",
      recurringId: recA,
      recurringYearMonth: "2026-06",
    });
    const juneB = await seedTx(bancolombia, {
      occurredOn: "2026-06-06",
      amountCents: RENT_AMOUNT,
      description: "Transferencia a cuenta *222222222",
      recurringId: recB,
      recurringYearMonth: "2026-06",
    });
    await db.insert(recurringLinkObservations).values([
      {
        userId: TEST_USER_ID,
        recurringId: recA,
        txId: juneA,
        yearMonth: "2026-06",
        realAmountCents: RENT_AMOUNT,
        realCurrency: "COP",
        descriptionRaw: "Transferencia a cuenta *111111111",
        accountId: bancolombia,
        manual: true,
      },
      {
        userId: TEST_USER_ID,
        recurringId: recB,
        txId: juneB,
        yearMonth: "2026-06",
        realAmountCents: RENT_AMOUNT,
        realCurrency: "COP",
        descriptionRaw: "Transferencia a cuenta *222222222",
        accountId: bancolombia,
        manual: true,
      },
    ]);

    const julyTx = await seedTx(bancolombia, {
      occurredOn: "2026-07-07",
      amountCents: RENT_AMOUNT,
      description: "Transferencia a cuenta *333333333",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-07");
    expect(result.autoLinked).toBe(0);
    expect(result.gapsCreated).toBe(2);

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, julyTx));
    expect(row.recurringId).toBeNull();
  });
});

// Keep the `and` import live — drizzle barrel exports trip tree-shakers.
void and;

// ---------------------------------------------------------------------------
// #1028: identical-fingerprint twins must also pair when the amount drifts
// inside the existing 1% band and the payer account differs. Prod shape:
// "Plan Tigo Aida" / "Plan Tigo Alejo", both $47.900 on account 5, single
// fingerprint UNE; November charges were $48.239 each FROM ACCOUNT 6 (tx
// 3220/3221) and neither linked, while every exact-amount month did.
//
// This is a SEPARATE pass from the exact-amount bijective grouping above,
// which stays untouched: the exact pass keeps its byte-identical contract,
// and this one only ever sees the leftovers it declined.
// ---------------------------------------------------------------------------
describe("detectGapsForMonth #1028 — drifted twins across accounts", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  async function seedTwins(accountId: number) {
    const recA = await seedRecurring(accountId, {
      label: "__gap_test tigo drift aida",
      amountCents: BigInt(-4790000),
      dayOfMonth: 10,
    });
    const recB = await seedRecurring(accountId, {
      label: "__gap_test tigo drift alejo",
      amountCents: BigInt(-4790000),
      dayOfMonth: 12,
    });
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: recA, pattern: "UNE", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: recB, pattern: "UNE", observationCount: 2 },
    ]);
    return { recA, recB };
  }

  it("two pattern-identical twins at -4790000 + two txs at -4823900 on ANOTHER account → both link, one each", async () => {
    const ownerAccount = await seedAccount("_tigo_owner");
    const payerAccount = await seedAccount("_tigo_payer");
    const { recA, recB } = await seedTwins(ownerAccount);

    const tx1 = await seedTx(payerAccount, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-4823900),
      description: "UNE TELCO UNE PAGO 1",
    });
    const tx2 = await seedTx(payerAccount, {
      occurredOn: "2026-04-12",
      amountCents: BigInt(-4823900),
      description: "UNE TELCO UNE PAGO 2",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(2);

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

  it("a drift OUTSIDE the 1% band still does not pair (no new guessing)", async () => {
    const ownerAccount = await seedAccount("_tigo_far_owner");
    const payerAccount = await seedAccount("_tigo_far_payer");
    await seedTwins(ownerAccount);

    await seedTx(payerAccount, {
      occurredOn: "2026-04-10",
      amountCents: BigInt(-5000000),
      description: "UNE TELCO UNE PAGO 1",
    });
    await seedTx(payerAccount, {
      occurredOn: "2026-04-12",
      amountCents: BigInt(-5000000),
      description: "UNE TELCO UNE PAGO 2",
    });

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-04");
    expect(result.autoLinked).toBe(0);
  });

  // Cross-group abstention is a property of the PLANNER, not of the whole-month
  // run: a tx this pass declines can still be claimed downstream by design, so
  // asserting it through detectGapsForMonth would pin the wrong thing.
  it("a tx inside the band of TWO different twin groups is paired with neither", () => {
    const windowStart = new Date("2026-04-01T00:00:00.000Z");
    const windowEndExclusive = new Date("2026-05-01T00:00:00.000Z");
    const member = (id: number, amountCents: bigint): ToProcessRow => ({
      id,
      accountId: 1,
      amountCents,
      currency: "COP",
      dayOfMonth: 10,
      skippedMonths: [],
    });

    const groups: RelaxedTwinGroup[] = [
      {
        anchorAmountCents: BigInt(-4790000),
        currency: "COP",
        patterns: new Set(["UNE", "TIGO"]),
        members: [member(1, BigInt(-4790000)), member(2, BigInt(-4790000))],
        windowStart,
        windowEndExclusive,
      },
      {
        anchorAmountCents: BigInt(-4850000),
        currency: "COP",
        patterns: new Set(["UNE", "MOVISTAR"]),
        members: [member(3, BigInt(-4850000)), member(4, BigInt(-4850000))],
        windowStart,
        windowEndExclusive,
      },
    ];

    // -4820000 sits inside 1% of BOTH anchors (-4790000 and -4850000), and its
    // token UNE belongs to both fingerprint sets: no signal can choose.
    const candidates: RelaxedTxCandidate[] = [
      {
        id: 10,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
        amountCents: BigInt(-4820000),
        currency: "COP",
        descriptionRaw: "UNE TELCO UNE PAGO",
      },
    ];

    expect(assignRelaxedTwins(groups, candidates)).toEqual([]);
  });

  it("planner pairs one tx per twin when only one group accepts them, in stable order", () => {
    const windowStart = new Date("2026-04-01T00:00:00.000Z");
    const windowEndExclusive = new Date("2026-05-01T00:00:00.000Z");
    const groups: RelaxedTwinGroup[] = [
      {
        anchorAmountCents: BigInt(-4790000),
        currency: "COP",
        patterns: new Set(["UNE"]),
        members: [
          {
            id: 22,
            accountId: 1,
            amountCents: BigInt(-4790000),
            currency: "COP",
            dayOfMonth: 12,
            skippedMonths: [],
          },
          {
            id: 21,
            accountId: 1,
            amountCents: BigInt(-4790000),
            currency: "COP",
            dayOfMonth: 10,
            skippedMonths: [],
          },
        ],
        windowStart,
        windowEndExclusive,
      },
    ];
    const candidates: RelaxedTxCandidate[] = [
      {
        id: 102,
        occurredAt: new Date("2026-04-12T00:00:00.000Z"),
        amountCents: BigInt(-4823900),
        currency: "COP",
        descriptionRaw: "UNE TELCO UNE PAGO 2",
      },
      {
        id: 101,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
        amountCents: BigInt(-4823900),
        currency: "COP",
        descriptionRaw: "UNE TELCO UNE PAGO 1",
      },
    ];

    // tx 101 (04-10) → member 21 (day 10); tx 102 (04-12) → member 22 (day 12).
    expect(assignRelaxedTwins(groups, candidates)).toEqual([
      { txId: 101, memberId: 21 },
      { txId: 102, memberId: 22 },
    ]);
  });

  it("a near-amount tx whose token contradicts the shared fingerprint stays unlinked (KFC guard)", async () => {
    const ownerAccount = await seedAccount("_tigo_token_owner");
    const payerAccount = await seedAccount("_tigo_token_payer");
    await seedTwins(ownerAccount);

    const kfc = await seedTx(payerAccount, {
      occurredOn: "2026-04-11",
      amountCents: BigInt(-4823900),
      description: "KFC UNICENTRO MEDELL",
    });

    await detectGapsForMonth(TEST_USER_ID, "2026-04");

    const [row] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, kfc));
    expect(row.recurringId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #1034 — an occurrence marked "paid from an account findash does not track"
// is closed exactly like a linked one: it never reaches `toProcess`, so no gap
// row is inserted, no notification fires, and a later cron run cannot re-open
// it. Removing the mark frees the slot again.
// ---------------------------------------------------------------------------

describe("detectGapsForMonth #1034 — paid from an untracked account", () => {
  const PAID_EXTERNAL = "paid-external";

  async function seedPaidExternalSlot(recurringId: number, ym: string) {
    await db.insert(recurringGaps).values({
      userId: TEST_USER_ID,
      recurringId,
      yearMonth: ym,
      resolution: PAID_EXTERNAL,
      resolvedAt: new Date(),
      resolutionTxId: null,
    });
  }

  async function readSlots(recurringId: number) {
    return db
      .select({
        yearMonth: recurringGaps.yearMonth,
        resolution: recurringGaps.resolution,
        resolutionTxId: recurringGaps.resolutionTxId,
      })
      .from(recurringGaps)
      .where(
        and(eq(recurringGaps.userId, TEST_USER_ID), eq(recurringGaps.recurringId, recurringId)),
      );
  }

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
  });
  afterEach(cleanup);

  it("creates no gap and emits no notification, while the following month still gaps (S8)", async () => {
    const accountId = await seedAccount("_paid_external");
    const recurringId = await seedRecurring(accountId, {
      label: "__gap_test seguridad social",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    await seedPaidExternalSlot(recurringId, "2026-11");

    const november = await detectGapsForMonth(TEST_USER_ID, "2026-11");
    await new Promise((r) => setTimeout(r, 0));

    expect(november.paidExternal).toBe(1);
    expect(november.gapsCreated).toBe(0);
    expect(mocks.emitNotification).not.toHaveBeenCalled();

    const slots = await readSlots(recurringId);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.yearMonth).toBe("2026-11");
    expect(slots[0]!.resolution).toBe(PAID_EXTERNAL);
    expect(slots[0]!.resolutionTxId).toBeNull();

    // A closed month must not swallow the next one.
    const december = await detectGapsForMonth(TEST_USER_ID, "2026-12");
    expect(december.gapsCreated).toBe(1);
    expect(december.paidExternal).toBe(0);

    const after = await readSlots(recurringId);
    expect(after.map((s) => `${s.yearMonth}:${s.resolution ?? "open"}`).sort()).toEqual([
      "2026-11:paid-external",
      "2026-12:open",
    ]);
  });

  it("re-opens the occurrence on the next run after the mark is removed (S9)", async () => {
    const accountId = await seedAccount("_paid_external_undo");
    const recurringId = await seedRecurring(accountId, {
      label: "__gap_test seguridad social undo",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    await seedPaidExternalSlot(recurringId, "2026-11");

    const closed = await detectGapsForMonth(TEST_USER_ID, "2026-11");
    expect(closed.gapsCreated).toBe(0);

    // Exactly the state unmarkOccurrencePaidExternal leaves behind (S2).
    await db
      .update(recurringGaps)
      .set({ resolution: null, resolutionTxId: null, resolvedAt: null })
      .where(
        and(
          eq(recurringGaps.userId, TEST_USER_ID),
          eq(recurringGaps.recurringId, recurringId),
          eq(recurringGaps.yearMonth, "2026-11"),
        ),
      );

    const reopened = await detectGapsForMonth(TEST_USER_ID, "2026-11");

    // The exclusion is gone: the occurrence is no longer reported as covered.
    expect(reopened.paidExternal).toBe(0);
    // The slot stays as an OPEN row (S2 returns the slot to open, it does not
    // delete it — same shape as unlinkTxFromRecurring), so the detector finds a
    // live gap rather than inserting a second row for the same unique slot.
    expect(reopened.gapsAlreadyOpen).toBe(1);
    expect(reopened.gapsCreated).toBe(0);

    const slots = await readSlots(recurringId);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.resolution).toBeNull();

    // And the month is claimable again: once a real payment shows up, the
    // detector links it (the mark is not silently absorbing the occurrence).
    const txId = await seedTx(accountId, {
      occurredOn: "2026-11-15",
      amountCents: BigInt(-1500000),
      description: "__gap_test seguridad social paid now",
    });
    const relinked = await detectGapsForMonth(TEST_USER_ID, "2026-11");
    expect(relinked.autoLinked).toBe(1);

    const [tx] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(tx.recurringId).toBe(recurringId);
  });

  it("does not let a later same-amount transaction overwrite the resolution (S11)", async () => {
    const accountId = await seedAccount("_paid_external_tx");
    const recurringId = await seedRecurring(accountId, {
      label: "__gap_test seguridad social tx",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    await seedPaidExternalSlot(recurringId, "2026-11");

    const laterTxId = await seedTx(accountId, {
      occurredOn: "2026-11-15",
      amountCents: BigInt(-1500000),
      description: "__gap_test later unrelated charge",
    });

    await detectGapsForMonth(TEST_USER_ID, "2026-11");
    await new Promise((r) => setTimeout(r, 0));

    const slots = await readSlots(recurringId);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.resolution).toBe(PAID_EXTERNAL);
    expect(slots[0]!.resolutionTxId).toBeNull();

    const [tx] = await db
      .select({ recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, laterTxId));
    expect(tx.recurringId).toBeNull();
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("only closes the marked recurring — a sibling recurring keeps its gap", async () => {
    const accountId = await seedAccount("_paid_external_sibling");
    const paidId = await seedRecurring(accountId, {
      label: "__gap_test paid sibling",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    const openId = await seedRecurring(accountId, {
      label: "__gap_test open sibling",
      amountCents: BigInt(-900000),
      dayOfMonth: 20,
    });
    await seedPaidExternalSlot(paidId, "2026-11");

    const result = await detectGapsForMonth(TEST_USER_ID, "2026-11");

    expect(result.paidExternal).toBe(1);
    expect(result.gapsCreated).toBe(1);

    const paidSlots = await readSlots(paidId);
    expect(paidSlots[0]!.resolution).toBe(PAID_EXTERNAL);

    const openSlots = await readSlots(openId);
    expect(openSlots).toHaveLength(1);
    expect(openSlots[0]!.yearMonth).toBe("2026-11");
    expect(openSlots[0]!.resolution).toBeNull();
  });
});
