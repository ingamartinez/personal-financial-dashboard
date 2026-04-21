import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, physicalCards, transactions, users } from "@/lib/db/schema";
import { getAvailableCreditCOP, listAccountsDetailed } from "./queries";

// #368: balance is now derived from SUM(transactions.amount_cents). Tests
// that want a specific opening balance must insert a tx — the stored
// accounts.balance_cents column is ignored by readers.
async function seedOpeningBalance(
  userId: number,
  accountId: number,
  currency: "COP" | "USD",
  amountCents: number,
): Promise<void> {
  if (amountCents === 0) return;
  await db
    .insert(categories)
    .values({
      userId,
      slug: "adjustments",
      name: "Ajustes de saldo",
      icon: "wrench",
      color: "#475569",
      sortOrder: 1000,
    })
    .onConflictDoNothing({ target: [categories.userId, categories.slug] });
  await db.insert(transactions).values({
    userId,
    accountId,
    occurredAt: new Date(),
    amountCents: BigInt(amountCents),
    currency,
    descriptionRaw: "__test_opening_balance",
    categorySlug: "adjustments",
    classificationMethod: "manual",
    source: "balance_adjustment",
    channel: "manual",
    isAdjustment: true,
  });
}

const MARKER = "__test_accounts_queries";
const OTHER_EMAIL = `${MARKER}-other@test.local`;

let USER_A = 0;
let USER_B = 0;

async function cleanup() {
  // Transactions reference accounts via ON DELETE RESTRICT FK — purge every
  // tx on any MARKER account (opening-balance #368 + ledger fixtures) before
  // the accounts themselves.
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${MARKER + "%"})`,
  );
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${MARKER + "%"}`);
  await db.execute(
    sql`DELETE FROM physical_cards WHERE metadata->>'coalescedFrom' IS NULL AND institution = 'Bancolombia' AND user_id IN (${USER_A}, ${USER_B})`,
  );
}

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ email: `${MARKER}-a@test.local`, name: "A" })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: OTHER_EMAIL, name: "B" })
    .returning({ id: users.id });
  USER_A = a.id;
  USER_B = b.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`);
});

describe("getAvailableCreditCOP", () => {
  afterEach(cleanup);

  async function seedPair(params: {
    userId: number;
    limitCents: number;
    copBalanceCents: number;
    usdBalanceCents: number;
    name?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(physicalCards).values({
      id,
      userId: params.userId,
      institution: "Bancolombia",
      network: "mastercard",
      last4: "7291",
      creditLimitCents: BigInt(params.limitCents),
    });
    const inserted = await db
      .insert(accounts)
      .values([
        {
          userId: params.userId,
          name: `${MARKER}${params.name ?? ""}-cop`,
          institution: "Bancolombia",
          type: "credit_card",
          currency: "COP",
          physicalCardId: id,
        },
        {
          userId: params.userId,
          name: `${MARKER}${params.name ?? ""}-usd`,
          institution: "Bancolombia",
          type: "credit_card",
          currency: "USD",
          physicalCardId: id,
        },
      ])
      .returning({ id: accounts.id, currency: accounts.currency });
    for (const row of inserted) {
      const opening = row.currency === "COP" ? params.copBalanceCents : params.usdBalanceCents;
      await seedOpeningBalance(params.userId, row.id, row.currency, opening);
    }
    return id;
  }

  it("returns full limit when both balances are zero", async () => {
    const id = await seedPair({
      userId: USER_A,
      limitCents: 20_000_000_00, // 20MM COP
      copBalanceCents: 0,
      usdBalanceCents: 0,
    });
    const available = await getAvailableCreditCOP(USER_A, id, 4100);
    expect(available).toBe(BigInt(20_000_000_00));
  });

  it("subtracts COP debt directly (balances stored negative)", async () => {
    // Limit 20MM, COP balance -500.000 (500k COP of debt)
    const id = await seedPair({
      userId: USER_A,
      limitCents: 20_000_000_00,
      copBalanceCents: -500_000_00,
      usdBalanceCents: 0,
    });
    const available = await getAvailableCreditCOP(USER_A, id, 4100);
    expect(available).toBe(BigInt(20_000_000_00 - 500_000_00));
  });

  it("converts USD debt to COP at the given rate", async () => {
    // Limit 20MM, USD balance -100,00 ($100 USD of debt) @ TRM 4100 → -410.000 COP
    const id = await seedPair({
      userId: USER_A,
      limitCents: 20_000_000_00,
      copBalanceCents: 0,
      usdBalanceCents: -100_00, // -$100,00 USD in cents
    });
    const available = await getAvailableCreditCOP(USER_A, id, 4100);
    expect(available).toBe(BigInt(20_000_000_00 - 100_00 * 4100));
  });

  it("handles mixed COP + USD debts (AS-3 scenario)", async () => {
    // Limit 20MM, COP -500k, USD -$100 @ 4100 → 19.090.000 COP available
    const id = await seedPair({
      userId: USER_A,
      limitCents: 20_000_000_00,
      copBalanceCents: -500_000_00,
      usdBalanceCents: -100_00,
      name: "-mixed",
    });
    const available = await getAvailableCreditCOP(USER_A, id, 4100);
    expect(available).toBe(BigInt(20_000_000_00 - 500_000_00 - 100_00 * 4100));
  });

  it("returns null when physical_card_id belongs to a different user (tenancy guard)", async () => {
    const id = await seedPair({
      userId: USER_B,
      limitCents: 10_000_000_00,
      copBalanceCents: 0,
      usdBalanceCents: 0,
      name: "-tenant",
    });
    const result = await getAvailableCreditCOP(USER_A, id, 4100);
    expect(result).toBeNull();
  });

  it("returns null for a non-existent physical_card_id", async () => {
    const fakeId = randomUUID();
    const result = await getAvailableCreditCOP(USER_A, fakeId, 4100);
    expect(result).toBeNull();
  });
});

describe("listAccountsDetailed: derived balance (#368, #370)", () => {
  afterEach(cleanup);

  it("derives balance from SUM(transactions)", async () => {
    // Post-#370 the stored `balance_cents` column is gone — balance is
    // computed exclusively from the ledger. This test seeds two txs and
    // asserts the reader returns SUM(amount_cents).
    const [acc] = await db
      .insert(accounts)
      .values({
        userId: USER_A,
        name: `${MARKER}-drift`,
        institution: "Bancolombia",
        type: "savings",
        currency: "COP",
      })
      .returning({ id: accounts.id });

    // Ledger: two expense txs totalling -3_000.
    await db
      .insert(categories)
      .values({
        userId: USER_A,
        slug: "adjustments",
        name: "Ajustes de saldo",
        icon: "wrench",
        color: "#475569",
        sortOrder: 1000,
      })
      .onConflictDoNothing({ target: [categories.userId, categories.slug] });
    await db.insert(transactions).values([
      {
        userId: USER_A,
        accountId: acc.id,
        occurredAt: new Date(),
        amountCents: BigInt(-1000),
        currency: "COP",
        descriptionRaw: "__test_opening_balance tx1",
        classificationMethod: "manual",
        source: "sms",
        channel: "bank",
      },
      {
        userId: USER_A,
        accountId: acc.id,
        occurredAt: new Date(),
        amountCents: BigInt(-2000),
        currency: "COP",
        descriptionRaw: "__test_opening_balance tx2",
        classificationMethod: "manual",
        source: "sms",
        channel: "bank",
      },
    ]);

    const rows = await listAccountsDetailed(USER_A);
    const found = rows.find((r) => r.name === `${MARKER}-drift`);
    expect(found).toBeDefined();
    // Balance is derived from the ledger: SUM(txs) = -3_000.
    expect(found!.balanceCents).toBe(BigInt(-3000));
  });
});

describe("listAccountsDetailed: physical card join", () => {
  afterEach(cleanup);

  it("returns physicalCard fields when an account is linked", async () => {
    const pcId = randomUUID();
    await db.insert(physicalCards).values({
      id: pcId,
      userId: USER_A,
      institution: "Bancolombia",
      name: "Bancolombia Mastercard *7291",
      network: "mastercard",
      last4: "7291",
      creditLimitCents: BigInt(15_000_000_00),
      statementCutoffDay: 15,
    });
    await db.insert(accounts).values({
      userId: USER_A,
      name: `${MARKER}-linked`,
      institution: "Bancolombia",
      type: "credit_card",
      currency: "COP",
      physicalCardId: pcId,
    });

    const rows = await listAccountsDetailed(USER_A);
    const linked = rows.find((r) => r.name === `${MARKER}-linked`);
    expect(linked).toBeDefined();
    expect(linked!.physicalCardId).toBe(pcId);
    expect(linked!.physicalCard).not.toBeNull();
    expect(linked!.physicalCard!.creditLimitCents).toBe(BigInt(15_000_000_00));
    expect(linked!.physicalCard!.statementCutoffDay).toBe(15);
    expect(linked!.physicalCard!.name).toBe("Bancolombia Mastercard *7291");
    expect(linked!.physicalCard!.network).toBe("mastercard");
    expect(linked!.physicalCard!.last4).toBe("7291");
  });

  it("returns physicalCard: null for single-currency accounts", async () => {
    await db.insert(accounts).values({
      userId: USER_A,
      name: `${MARKER}-single`,
      institution: "Bancolombia",
      type: "savings",
      currency: "COP",
    });
    const rows = await listAccountsDetailed(USER_A);
    const single = rows.find((r) => r.name === `${MARKER}-single`);
    expect(single).toBeDefined();
    expect(single!.physicalCardId).toBeNull();
    expect(single!.physicalCard).toBeNull();
  });

  it("never joins a physical_card belonging to another user", async () => {
    const pcId = randomUUID();
    await db.insert(physicalCards).values({
      id: pcId,
      userId: USER_B,
      institution: "Bancolombia",
      creditLimitCents: BigInt(99_999),
    });
    // Artisanal dangling pointer: pretend something wrote user A's account
    // pointing at user B's physical_card (this should never happen in prod,
    // but the join must defend against it).
    await db.insert(accounts).values({
      userId: USER_A,
      name: `${MARKER}-crosstenant`,
      institution: "Bancolombia",
      type: "credit_card",
      currency: "COP",
      physicalCardId: pcId,
    });

    const rowsA = await listAccountsDetailed(USER_A);
    const crossed = rowsA.find((r) => r.name === `${MARKER}-crosstenant`);
    // The row is returned (it's A's account), but physicalCard must be null
    // because the join filtered out the cross-tenant parent.
    expect(crossed).toBeDefined();
    expect(crossed!.physicalCardId).toBe(pcId);
    expect(crossed!.physicalCard).toBeNull();

    // Cleanup this cross-tenant row explicitly — the MARKER deletes it, but the
    // assertion above is the important part. Also nuke the PC.
    await db.execute(sql`DELETE FROM accounts WHERE name = ${MARKER + "-crosstenant"}`);
    await db.delete(physicalCards).where(eq(physicalCards.id, pcId));
  });
});
