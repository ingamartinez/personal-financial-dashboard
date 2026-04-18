import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, recurringGaps, recurringTransactions, transactions } from "@/lib/db/schema";
import { autoLinkTransaction } from "./auto-link";

const TEST_ACCOUNT = "__autolink_test_account__";

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_gaps WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__autolink%')`,
  );
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__autolink%'`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE '__autolink%'`);
  await db.execute(sql`DELETE FROM accounts WHERE name = ${TEST_ACCOUNT}`);
}

async function seedAccount() {
  const [a] = await db
    .insert(accounts)
    .values({
      name: TEST_ACCOUNT,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return a.id;
}

async function seedRecurringWithGap(
  accountId: number,
  opts: { label: string; amountCents: bigint; dayOfMonth: number; yearMonth: string },
) {
  const [r] = await db
    .insert(recurringTransactions)
    .values({
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
    .values({ recurringId: r.id, yearMonth: opts.yearMonth })
    .returning({ id: recurringGaps.id });

  return { recurringId: r.id, gapId: g.id };
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
