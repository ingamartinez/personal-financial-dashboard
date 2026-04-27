import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accountSnapshots,
  accounts,
  categories,
  physicalCards,
  transactions,
  users,
} from "@/lib/db/schema";
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

// ---------------------------------------------------------------------------
// derivedBalanceCentsSql — snapshot-anchored balance (#562c)
//
// These tests verify the new formula:
//   WITH snapshot: balance = snapshot.balance_cents + SUM(txs where occurred_at >= snapshot_date)
//   WITHOUT snapshot: balance = COALESCE(SUM(all non-archived txs), 0)  (original behaviour)
// ---------------------------------------------------------------------------

describe("derivedBalanceCentsSql: snapshot-anchored balance (#562c)", () => {
  afterEach(async () => {
    // accountSnapshots has ON DELETE CASCADE from accounts, so deleting the
    // MARKER accounts also deletes their snapshots. But we also clean up
    // any snapshots explicitly before the accounts (in case a test created
    // a snapshot without an account marker).
    await db.execute(
      sql`DELETE FROM account_snapshots
          WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${MARKER + "%"})`,
    );
    await cleanup();
  });

  // Helper: insert an account and return its id.
  async function seedAccount(name: string): Promise<number> {
    const [row] = await db
      .insert(accounts)
      .values({
        userId: USER_A,
        name: `${MARKER}${name}`,
        institution: "ARQ (DolarApp)",
        type: "savings",
        currency: "USD",
      })
      .returning({ id: accounts.id });
    return row.id;
  }

  // Helper: insert a transaction at a specific timestamp.
  async function seedTx(accountId: number, amountCents: number, occurredAt: Date): Promise<void> {
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
    await db.insert(transactions).values({
      userId: USER_A,
      accountId,
      occurredAt,
      amountCents: BigInt(amountCents),
      currency: "USD",
      descriptionRaw: `__snapshot_test_tx_${amountCents}`,
      classificationMethod: "manual",
      source: "balance_adjustment",
      channel: "manual",
      isAdjustment: true,
    });
  }

  // Helper: insert a snapshot.
  async function seedSnapshot(
    accountId: number,
    snapshotDate: string,
    balanceCents: number,
  ): Promise<void> {
    await db.insert(accountSnapshots).values({
      userId: USER_A,
      accountId,
      snapshotDate,
      balanceCents: BigInt(balanceCents),
      metadata: { source: "test" },
    });
  }

  it("account WITHOUT snapshot → balance = SUM(all txs) (original behaviour preserved)", async () => {
    const accId = await seedAccount("-snap-no-snapshot");
    await seedTx(accId, 10_00, new Date(Date.UTC(2026, 0, 5)));
    await seedTx(accId, -3_00, new Date(Date.UTC(2026, 0, 20)));

    const rows = await listAccountsDetailed(USER_A);
    const acc = rows.find((r) => r.name === `${MARKER}-snap-no-snapshot`);
    expect(acc).toBeDefined();
    // SUM(10_00 + (-3_00)) = 7_00
    expect(acc!.balanceCents).toBe(BigInt(7_00));
  });

  it("account WITH snapshot → balance = snapshot + SUM(txs on or after snapshot_date)", async () => {
    const accId = await seedAccount("-snap-with-snapshot");
    const snapDate = "2026-02-01";
    // snapshot at Feb 1 with balance 50_00
    await seedSnapshot(accId, snapDate, 50_00);
    // tx BEFORE snapshot date — should NOT be included in the delta
    await seedTx(accId, 10_00, new Date(Date.UTC(2026, 0, 15)));
    // txs ON and AFTER snapshot date — should be included
    await seedTx(accId, -5_00, new Date(Date.UTC(2026, 1, 1))); // exactly snapshot_date
    await seedTx(accId, 3_00, new Date(Date.UTC(2026, 1, 15)));

    const rows = await listAccountsDetailed(USER_A);
    const acc = rows.find((r) => r.name === `${MARKER}-snap-with-snapshot`);
    expect(acc).toBeDefined();
    // balance = 50_00 (snapshot) + (-5_00 + 3_00) (delta on/after Feb 1) = 48_00
    expect(acc!.balanceCents).toBe(BigInt(48_00));
  });

  it("multiple snapshots → only the LATEST one anchors", async () => {
    const accId = await seedAccount("-snap-multi-snapshot");
    // Two snapshots: Jan 1 and Feb 1. Feb 1 is latest.
    await seedSnapshot(accId, "2026-01-01", 100_00);
    await seedSnapshot(accId, "2026-02-01", 200_00);
    // tx between Jan 1 and Feb 1 — should NOT be in delta (before Feb 1 snapshot)
    await seedTx(accId, 15_00, new Date(Date.UTC(2026, 0, 15)));
    // tx after Feb 1
    await seedTx(accId, -20_00, new Date(Date.UTC(2026, 1, 10)));

    const rows = await listAccountsDetailed(USER_A);
    const acc = rows.find((r) => r.name === `${MARKER}-snap-multi-snapshot`);
    expect(acc).toBeDefined();
    // balance = 200_00 (Feb snapshot) + (-20_00) (delta after Feb 1) = 180_00
    expect(acc!.balanceCents).toBe(BigInt(180_00));
  });

  it("soft-deleted txs are excluded from the delta even with a snapshot", async () => {
    const accId = await seedAccount("-snap-soft-delete");
    await seedSnapshot(accId, "2026-01-01", 100_00);
    // Insert a tx then archive it (set deleted_at)
    await seedTx(accId, 50_00, new Date(Date.UTC(2026, 0, 10)));
    await db.execute(
      sql`UPDATE transactions SET deleted_at = now()
          WHERE account_id = ${accId}`,
    );
    // Insert a live tx after the snapshot
    await seedTx(accId, 25_00, new Date(Date.UTC(2026, 0, 20)));

    const rows = await listAccountsDetailed(USER_A);
    const acc = rows.find((r) => r.name === `${MARKER}-snap-soft-delete`);
    expect(acc).toBeDefined();
    // balance = 100_00 (snapshot) + 25_00 (live tx) = 125_00
    // The archived 50_00 tx is excluded.
    expect(acc!.balanceCents).toBe(BigInt(125_00));
  });

  it("account with snapshot but NO txs after snapshot → balance = snapshot value", async () => {
    const accId = await seedAccount("-snap-no-delta");
    await seedSnapshot(accId, "2026-03-01", 75_00);
    // All txs are BEFORE the snapshot date
    await seedTx(accId, 10_00, new Date(Date.UTC(2026, 1, 15)));

    const rows = await listAccountsDetailed(USER_A);
    const acc = rows.find((r) => r.name === `${MARKER}-snap-no-delta`);
    expect(acc).toBeDefined();
    // balance = 75_00 (snapshot) + 0 (no txs on/after Mar 1) = 75_00
    expect(acc!.balanceCents).toBe(BigInt(75_00));
  });
});
