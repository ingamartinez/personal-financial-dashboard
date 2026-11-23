import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringGaps,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { getUpcomingForMonth, getUpcomingForWindow } from "./upcoming";

const TEST_USER_ID = 1;

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_description_patterns WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__upmonth%')`,
  );
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__upmonth%'`);
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE '__upmonth%')`,
  );
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE '__upmonth%'`);
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE '__upmonth%'`);
}

async function seedAccount(suffix = "") {
  const [a] = await db
    .insert(accounts)
    .values({
      userId: TEST_USER_ID,
      name: `__upmonth_acct${suffix}`,
      institution: "TestBank",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return a.id;
}

async function seedRecurring(
  accountId: number,
  opts: { label: string; amountCents: bigint; dayOfMonth: number },
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
    })
    .returning({ id: recurringTransactions.id });
  return r.id;
}

async function seedTx(
  accountId: number,
  opts: { occurredOn: string; amountCents: bigint; description: string },
) {
  const [t] = await db
    .insert(transactions)
    .values({
      userId: TEST_USER_ID,
      accountId,
      occurredAt: new Date(`${opts.occurredOn}T12:00:00Z`),
      amountCents: opts.amountCents,
      currency: "COP",
      descriptionRaw: opts.description,
      source: "manual",
    })
    .returning({ id: transactions.id });
  return t.id;
}

describe("getUpcomingForMonth — #804 WARNING fix: status-dot heuristic token guard", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("does NOT paint a recurring as matched when a same-amount purchase has an unmatched token (KFC shape)", async () => {
    const accountId = await seedAccount("_kfc");
    const recurringId = await seedRecurring(accountId, {
      label: "__upmonth appletv",
      amountCents: BigInt(-2990000),
      dayOfMonth: 15,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "APPLE",
      observationCount: 2,
    });

    await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-2990000),
      description: "KFC UNICENTRO MEDELL",
    });

    const items = await getUpcomingForMonth({ userId: TEST_USER_ID, year: 2026, month: 4 });
    const item = items.find((i) => i.recurringId === recurringId);
    expect(item).toBeDefined();
    expect(item!.status).not.toBe("matched");
  });

  it("still paints matched via amount-only when the tx description has no extractable token", async () => {
    const accountId = await seedAccount("_bootstrap");
    const recurringId = await seedRecurring(accountId, {
      label: "__upmonth bootstrap",
      amountCents: BigInt(-100000),
      dayOfMonth: 15,
    });

    await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-100000),
      description: "1234 5678",
    });

    const items = await getUpcomingForMonth({ userId: TEST_USER_ID, year: 2026, month: 4 });
    const item = items.find((i) => i.recurringId === recurringId);
    expect(item).toBeDefined();
    expect(item!.status).toBe("matched");
  });

  it("still paints matched when the token correctly matches the recurring's own learned pattern", async () => {
    const accountId = await seedAccount("_match");
    const recurringId = await seedRecurring(accountId, {
      label: "__upmonth netflix",
      amountCents: BigInt(-4490000),
      dayOfMonth: 15,
    });
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "NETFLIX",
      observationCount: 2,
    });

    await seedTx(accountId, {
      occurredOn: "2026-04-15",
      amountCents: BigInt(-4490000),
      description: "NETFLIX*DL",
    });

    const items = await getUpcomingForMonth({ userId: TEST_USER_ID, year: 2026, month: 4 });
    const item = items.find((i) => i.recurringId === recurringId);
    expect(item).toBeDefined();
    expect(item!.status).toBe("matched");
  });
});

// ---------------------------------------------------------------------------
// #1034 — a slot marked "paid from an account findash does not track" is
// covered, but it is neither a matched payment (there is no transaction) nor
// pending. The read model reports it as its own state.
// ---------------------------------------------------------------------------

describe("getUpcomingForMonth — #1034 paid from an untracked account", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  async function seedPaidExternalSlot(recurringId: number, ym: string) {
    await db.insert(recurringGaps).values({
      userId: TEST_USER_ID,
      recurringId,
      yearMonth: ym,
      resolution: "paid-external",
      resolvedAt: new Date(),
      resolutionTxId: null,
    });
  }

  it("reports 'paid-external' with no matchedTransactionId and no claimed paid amount (S10)", async () => {
    const accountId = await seedAccount("_paid_external");
    const recurringId = await seedRecurring(accountId, {
      label: "__upmonth seguridad social",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    await seedPaidExternalSlot(recurringId, "2026-11");

    const items = await getUpcomingForMonth({
      userId: TEST_USER_ID,
      year: 2026,
      month: 11,
      today: new Date("2026-11-20T12:00:00Z"),
    });
    const item = items.find((i) => i.recurringId === recurringId);

    expect(item).toBeDefined();
    expect(item!.status).toBe("paid-external");
    expect(item!.status).not.toBe("matched");
    expect(item!.matchedTransactionId).toBeNull();
    // Nothing claims a payment amount for this slot — the only amount reported
    // is the recurring's own expected one.
    expect(item!.amountCents).toBe(BigInt(-1500000));
    expect(item).not.toHaveProperty("paidAmountCents");
    expect(item).not.toHaveProperty("matchedAmountCents");
  });

  it("a transaction that happens to land near the amount does not turn it into a match (S11)", async () => {
    const accountId = await seedAccount("_paid_external_tx");
    const recurringId = await seedRecurring(accountId, {
      label: "__upmonth seguridad social tx",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    await seedPaidExternalSlot(recurringId, "2026-11");
    await seedTx(accountId, {
      occurredOn: "2026-11-15",
      amountCents: BigInt(-1500000),
      description: "__upmonth unrelated but same amount",
    });

    const items = await getUpcomingForMonth({
      userId: TEST_USER_ID,
      year: 2026,
      month: 11,
      today: new Date("2026-11-20T12:00:00Z"),
    });
    const item = items.find((i) => i.recurringId === recurringId);

    expect(item).toBeDefined();
    expect(item!.status).toBe("paid-external");
    expect(item!.matchedTransactionId).toBeNull();
  });

  it("getUpcomingForWindow never surfaces a paid-external slot as pending", async () => {
    const accountId = await seedAccount("_paid_external_window");
    const recurringId = await seedRecurring(accountId, {
      label: "__upmonth seguridad social window",
      amountCents: BigInt(-1500000),
      dayOfMonth: 15,
    });
    await seedPaidExternalSlot(recurringId, "2026-11");

    const items = await getUpcomingForWindow({
      userId: TEST_USER_ID,
      today: new Date("2026-11-14T12:00:00Z"),
    });

    expect(items.find((i) => i.recurringId === recurringId)).toBeUndefined();
  });
});
