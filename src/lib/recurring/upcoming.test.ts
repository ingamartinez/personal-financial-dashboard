import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { getUpcomingForMonth } from "./upcoming";

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
