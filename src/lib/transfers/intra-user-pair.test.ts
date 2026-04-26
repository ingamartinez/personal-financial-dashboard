// Integration tests for pairIntraUserTransfer (#518).
//
// These tests hit findash_test (forced by vitest.setup.ts). Run
// `bun run db:migrate:test` before this suite.
//
// Test matrix (7 scenarios from the issue acceptance criteria):
//   1. Same-currency happy path: two txs, opposite sign, same currency, ±24h window → paired.
//   2. Cross-currency happy path: ARQ USD debit + Bancolombia COP credit via PEXTO → paired.
//   3. Salary skip: receiver counterparty has is_salary=true → NOT paired.
//   4. Out of window: 25h delta → NOT paired.
//   5. Different currency without PEXTO match → NOT paired.
//   6. Tenant safety: same amount + same window but different user_id → NOT paired.
//   7. Reporting classification: paired tx has channel='transfer', categorySlug=null.
//   + Ledger consistency invariant: Σ(amounts) of a paired group is 0.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  counterparties,
  fiatPartners,
  transactions,
  userAliases,
  users,
} from "@/lib/db/schema";
import { extractArqMeta, pairIntraUserTransfer, resetFiatPartnerCache } from "./intra-user-pair";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = "INTRA_PAIR_TEST";

let userId: number;
let savingsAccountId: number; // COP savings
let secondCopAccountId: number; // COP second account (for same-currency transfer target)
let arqAccountId: number; // USD ARQ account
let otherUserId: number;
let otherSavingsAccountId: number;

// Counterparty row for salary tests.
let salaryCounterpartyId: number;

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM counterparties WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM user_aliases WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
  // Remove test-injected fiat partners if any.
  await db.delete(fiatPartners).where(sql`${fiatPartners.partnerName} LIKE ${"TEST_PEXTO_%"}`);
  resetFiatPartnerCache();
}

beforeAll(async () => {
  await cleanup();

  // Main test user.
  const [u] = await db
    .insert(users)
    .values({ email: `${TAG}-main@test.local`, name: "Alejandro Martinez" })
    .returning({ id: users.id });
  userId = u.id;

  // COP savings account.
  const [acct1] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}-savings-cop`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      currency: "COP",
      type: "savings",
    })
    .returning({ id: accounts.id });
  savingsAccountId = acct1.id;

  // Second COP account (transfer destination).
  const [acct2] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}-nequi-cop`,
      institution: "Nequi",
      institutionSlug: "nequi",
      currency: "COP",
      type: "savings",
    })
    .returning({ id: accounts.id });
  secondCopAccountId = acct2.id;

  // ARQ USD account.
  const [acct3] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}-arq-usd`,
      institution: "ARQ (DolarApp)",
      institutionSlug: "other",
      currency: "USD",
      type: "savings",
    })
    .returning({ id: accounts.id });
  arqAccountId = acct3.id;

  // Other user (tenant isolation tests).
  const [u2] = await db
    .insert(users)
    .values({ email: `${TAG}-other@test.local`, name: "Other User" })
    .returning({ id: users.id });
  otherUserId = u2.id;

  const [acct4] = await db
    .insert(accounts)
    .values({
      userId: otherUserId,
      name: `${TAG}-other-savings`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      currency: "COP",
      type: "savings",
    })
    .returning({ id: accounts.id });
  otherSavingsAccountId = acct4.id;

  // Salary counterparty for the salary-block test.
  const [cp] = await db
    .insert(counterparties)
    .values({ userId, displayName: `${TAG}-salary-employer`, isSalary: true })
    .returning({ id: counterparties.id });
  salaryCounterpartyId = cp.id;

  // User aliases for cross-currency matching.
  await db
    .insert(userAliases)
    .values([
      { userId, alias: "Alejandro Martinez" },
      { userId, alias: "Alejandro Rafael Martinez" },
      { userId, alias: "Alejandro Rafael Martinez Maldonado" },
    ])
    .onConflictDoNothing();

  // Ensure PEXTO COLOMBIA fiat partner exists (should be seeded by migration 0065).
  await db
    .insert(fiatPartners)
    .values({ sourceSystem: "arq", partnerName: "PEXTO COLOMBIA", active: true })
    .onConflictDoNothing();

  resetFiatPartnerCache();
});

afterAll(async () => {
  await cleanup();
});

// Helper: delete test txs after each case so they don't interfere.
async function cleanTxs(): Promise<void> {
  await db.execute(
    sql`DELETE FROM transactions WHERE user_id IN (${userId}, ${otherUserId}) AND raw_data @> '{"_test": true}'`,
  );
  resetFiatPartnerCache();
}

async function insertTx(opts: {
  userId: number;
  accountId: number;
  amountCents: bigint;
  currency: "COP" | "USD";
  occurredAt: Date;
  categorySlug?: string | null;
  channel?: "bank" | "transfer" | "manual";
  counterpartyId?: number | null;
  merchant?: string | null;
  source?: string;
  rawData?: Record<string, unknown>;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: opts.accountId,
      amountCents: opts.amountCents,
      currency: opts.currency,
      occurredAt: opts.occurredAt,
      categorySlug: opts.categorySlug ?? null,
      channel: opts.channel ?? "bank",
      counterpartyId: opts.counterpartyId ?? null,
      merchant: opts.merchant ?? null,
      source: (opts.source ?? "manual") as "manual",
      descriptionRaw: "test",
      classificationMethod: "manual",
      rawData: { _test: true, ...opts.rawData },
    })
    .returning({ id: transactions.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("pairIntraUserTransfer", () => {
  // 1. Same-currency happy path
  it("pairs same-currency COP transfer_sent ↔ transfer_received within ±24h window", async () => {
    const t = new Date("2026-04-15T14:00:00Z");

    const debitId = await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: BigInt(-500_000_00), // -500,000 COP
      currency: "COP",
      occurredAt: t,
      channel: "bank",
    });

    const creditId = await insertTx({
      userId,
      accountId: secondCopAccountId,
      amountCents: BigInt(500_000_00), // +500,000 COP
      currency: "COP",
      occurredAt: new Date(t.getTime() + 5 * 60 * 1000), // 5 min later
      channel: "bank",
    });

    // Pair the debit leg.
    const result = await pairIntraUserTransfer(
      {},
      {
        id: debitId,
        userId,
        accountId: savingsAccountId,
        channel: "bank",
        amountCents: BigInt(-500_000_00),
        currency: "COP",
        occurredAt: t,
        counterparty: null,
        rawData: { _test: true },
      },
    );

    expect(result.groupId).not.toBeNull();
    expect(result.pairedTxId).toBe(creditId);

    // Verify DB state.
    const rows = await db
      .select({
        id: transactions.id,
        transferGroupId: transactions.transferGroupId,
        channel: transactions.channel,
        categorySlug: transactions.categorySlug,
        amountCents: transactions.amountCents,
      })
      .from(transactions)
      .where(sql`${transactions.id} IN (${debitId}, ${creditId})`);

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.transferGroupId).toBe(result.groupId);
      expect(r.channel).toBe("transfer");
      expect(r.categorySlug).toBeNull();
    }

    // Ledger invariant: Σ = 0.
    const sum = rows.reduce((acc, r) => acc + r.amountCents, BigInt(0));
    expect(sum).toBe(BigInt(0));

    await cleanTxs();
  });

  // 2. Cross-currency happy path: ARQ → Bancolombia via PEXTO
  it("pairs ARQ USD debit ↔ Bancolombia COP credit from PEXTO within ±24h window", async () => {
    const t = new Date("2026-04-16T10:00:00Z");
    const copAmount = BigInt(2_104_000_00); // 2,104,000 COP in cents

    const arqRawData: Record<string, unknown> = {
      _test: true,
      kind: "transfer_sent",
      arq: {
        recipient_name: "Alejandro Martinez",
      },
      fx: {
        originalCurrency: "USD",
        originalAmountCents: "56381",
        trmToAccountCurrency: 3731,
        trmSource: "email_implied",
        copAmountCents: copAmount.toString(),
      },
    };

    const arqTxId = await insertTx({
      userId,
      accountId: arqAccountId,
      amountCents: BigInt(-56381), // -563.81 USDc
      currency: "USD",
      occurredAt: t,
      channel: "transfer",
      source: "gmail_arq",
      rawData: arqRawData,
    });

    // Bancolombia credit from PEXTO — arrives 2h later.
    const bancoTxId = await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: copAmount,
      currency: "COP",
      occurredAt: new Date(t.getTime() + 2 * 60 * 60 * 1000),
      channel: "bank",
      merchant: "PEXTO COLOMBIA",
    });

    // Pair the ARQ leg.
    const result = await pairIntraUserTransfer(
      {},
      {
        id: arqTxId,
        userId,
        accountId: arqAccountId,
        channel: "transfer",
        amountCents: BigInt(-56381),
        currency: "USD",
        occurredAt: t,
        counterparty: "Alejandro Martinez",
        rawData: arqRawData,
      },
    );

    expect(result.groupId).not.toBeNull();
    expect(result.pairedTxId).toBe(bancoTxId);

    const rows = await db
      .select({
        id: transactions.id,
        transferGroupId: transactions.transferGroupId,
        channel: transactions.channel,
        categorySlug: transactions.categorySlug,
        amountCents: transactions.amountCents,
      })
      .from(transactions)
      .where(sql`${transactions.id} IN (${arqTxId}, ${bancoTxId})`);

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.transferGroupId).toBe(result.groupId);
      expect(r.channel).toBe("transfer");
      expect(r.categorySlug).toBeNull();
    }

    await cleanTxs();
  });

  // 3. Salary skip
  it("does NOT pair when the receiver has a counterparty with is_salary=true", async () => {
    const t = new Date("2026-04-17T09:00:00Z");

    const senderId = await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: BigInt(-1_000_000_00),
      currency: "COP",
      occurredAt: t,
    });

    // The "receiver" tx is linked to a salary counterparty.
    const salaryTxId = await insertTx({
      userId,
      accountId: secondCopAccountId,
      amountCents: BigInt(1_000_000_00),
      currency: "COP",
      occurredAt: t,
      counterpartyId: salaryCounterpartyId,
    });

    const result = await pairIntraUserTransfer(
      {},
      {
        id: senderId,
        userId,
        accountId: savingsAccountId,
        channel: "bank",
        amountCents: BigInt(-1_000_000_00),
        currency: "COP",
        occurredAt: t,
        counterparty: null,
        rawData: { _test: true },
      },
    );

    // Should NOT pair.
    expect(result.groupId).toBeNull();
    expect(result.pairedTxId).toBeNull();

    // Both txs remain ungrouped.
    const rows = await db
      .select({ transferGroupId: transactions.transferGroupId })
      .from(transactions)
      .where(sql`${transactions.id} IN (${senderId}, ${salaryTxId})`);

    for (const r of rows) {
      expect(r.transferGroupId).toBeNull();
    }

    await cleanTxs();
  });

  // 4. Out of window (25h → not paired)
  it("does NOT pair when the partner tx is 25h away (outside ±24h window)", async () => {
    const t = new Date("2026-04-18T10:00:00Z");

    const debitId = await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: BigInt(-200_000_00),
      currency: "COP",
      occurredAt: t,
    });

    // Credit is 25h later — outside the batch window.
    await insertTx({
      userId,
      accountId: secondCopAccountId,
      amountCents: BigInt(200_000_00),
      currency: "COP",
      occurredAt: new Date(t.getTime() + 25 * 60 * 60 * 1000),
    });

    const result = await pairIntraUserTransfer(
      {},
      {
        id: debitId,
        userId,
        accountId: savingsAccountId,
        channel: "bank",
        amountCents: BigInt(-200_000_00),
        currency: "COP",
        occurredAt: t,
        counterparty: null,
        rawData: { _test: true },
      },
    );

    expect(result.groupId).toBeNull();

    await cleanTxs();
  });

  // 5. Different currency without PEXTO match → NOT paired
  it("does NOT pair a USD tx with a COP tx when there is no PEXTO counterparty", async () => {
    const t = new Date("2026-04-19T12:00:00Z");

    const usdTxId = await insertTx({
      userId,
      accountId: arqAccountId,
      amountCents: BigInt(-100_00), // -100 USD
      currency: "USD",
      occurredAt: t,
      source: "gmail_arq",
      rawData: {
        _test: true,
        kind: "transfer_sent",
        arq: { recipient_name: "Alejandro Martinez" },
        fx: {},
      },
    });

    // COP credit but NO PEXTO merchant — unrelated income.
    await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: BigInt(400_000_00),
      currency: "COP",
      occurredAt: new Date(t.getTime() + 30 * 60 * 1000),
      merchant: "FREELANCE CLIENT",
    });

    const result = await pairIntraUserTransfer(
      {},
      {
        id: usdTxId,
        userId,
        accountId: arqAccountId,
        channel: "transfer",
        amountCents: BigInt(-100_00),
        currency: "USD",
        occurredAt: t,
        counterparty: "Alejandro Martinez",
        rawData: {
          _test: true,
          kind: "transfer_sent",
          arq: { recipient_name: "Alejandro Martinez" },
          fx: {},
        },
      },
    );

    // No cop_amount_cents in fx → falls back to same-currency path which finds no USD match.
    expect(result.groupId).toBeNull();

    await cleanTxs();
  });

  // 6. Tenant safety: different user_id → NOT paired
  it("does NOT pair across different user_ids (tenant isolation)", async () => {
    const t = new Date("2026-04-20T10:00:00Z");

    // Main user's debit.
    const myDebitId = await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: BigInt(-300_000_00),
      currency: "COP",
      occurredAt: t,
    });

    // Other user has a matching credit in their own account — must NOT pair with myDebit.
    await insertTx({
      userId: otherUserId,
      accountId: otherSavingsAccountId,
      amountCents: BigInt(300_000_00),
      currency: "COP",
      occurredAt: t,
    });

    const result = await pairIntraUserTransfer(
      {},
      {
        id: myDebitId,
        userId,
        accountId: savingsAccountId,
        channel: "bank",
        amountCents: BigInt(-300_000_00),
        currency: "COP",
        occurredAt: t,
        counterparty: null,
        rawData: { _test: true },
      },
    );

    // Must not pair — pairing must only happen within the same user_id.
    expect(result.groupId).toBeNull();

    await cleanTxs();
  });

  // 7. Reporting: paired tx does NOT appear as ingreso/gasto
  it("paired transfer has channel=transfer and categorySlug=null (excluded from income/expense reports)", async () => {
    const t = new Date("2026-04-21T10:00:00Z");

    const debitId = await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: BigInt(-150_000_00),
      currency: "COP",
      occurredAt: t,
      channel: "bank",
    });

    const creditId = await insertTx({
      userId,
      accountId: secondCopAccountId,
      amountCents: BigInt(150_000_00),
      currency: "COP",
      occurredAt: new Date(t.getTime() + 60_000),
      channel: "bank",
    });

    const result = await pairIntraUserTransfer(
      {},
      {
        id: debitId,
        userId,
        accountId: savingsAccountId,
        channel: "bank",
        amountCents: BigInt(-150_000_00),
        currency: "COP",
        occurredAt: t,
        counterparty: null,
        rawData: { _test: true },
      },
    );

    expect(result.groupId).not.toBeNull();

    // Simulate reporting query: exclude transfer-channel txs.
    const reportRows = await db
      .select({ id: transactions.id, amountCents: transactions.amountCents })
      .from(transactions)
      .where(
        and(
          sql`${transactions.id} IN (${debitId}, ${creditId})`,
          // Reporting layer condition: skip transfers.
          sql`${transactions.channel} != 'transfer'`,
        ),
      );

    // Both legs should be excluded from reporting.
    expect(reportRows).toHaveLength(0);

    await cleanTxs();
  });

  // Idempotency: calling pairIntraUserTransfer on an already-grouped tx is a no-op.
  it("is idempotent — calling on an already-grouped tx returns { groupId: null }", async () => {
    const t = new Date("2026-04-22T10:00:00Z");

    const debitId = await insertTx({
      userId,
      accountId: savingsAccountId,
      amountCents: BigInt(-75_000_00),
      currency: "COP",
      occurredAt: t,
    });

    await insertTx({
      userId,
      accountId: secondCopAccountId,
      amountCents: BigInt(75_000_00),
      currency: "COP",
      occurredAt: t,
    });

    // First call: pairs.
    const first = await pairIntraUserTransfer(
      {},
      {
        id: debitId,
        userId,
        accountId: savingsAccountId,
        channel: "bank",
        amountCents: BigInt(-75_000_00),
        currency: "COP",
        occurredAt: t,
        counterparty: null,
        rawData: { _test: true },
      },
    );
    expect(first.groupId).not.toBeNull();

    // Second call: must be a no-op (already grouped).
    const second = await pairIntraUserTransfer(
      {},
      {
        id: debitId,
        userId,
        accountId: savingsAccountId,
        channel: "transfer",
        amountCents: BigInt(-75_000_00),
        currency: "COP",
        occurredAt: t,
        counterparty: null,
        rawData: { _test: true },
      },
    );
    expect(second.groupId).toBeNull();

    await cleanTxs();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for extractArqMeta
// ---------------------------------------------------------------------------

describe("extractArqMeta", () => {
  it("returns null for null rawData", () => {
    expect(extractArqMeta(null)).toBeNull();
  });

  it("returns null when arq block is missing", () => {
    expect(extractArqMeta({ kind: "purchase" })).toBeNull();
  });

  it("extracts recipientName and copAmountCents from email-parser shape", () => {
    const rawData = {
      arq: { recipient_name: "Alejandro Martinez" },
      fx: { copAmountCents: "2104000" },
    };
    const result = extractArqMeta(rawData);
    expect(result).not.toBeNull();
    expect(result!.recipientName).toBe("Alejandro Martinez");
    expect(result!.copAmountCents).toBe(BigInt(2104000));
  });

  it("prefers merged_statement recipient_name_from_statement over arq block", () => {
    const rawData = {
      arq: { recipient_name: "Original Name" },
      merged_statement: {
        arq: { recipient_name_from_statement: "Statement Name" },
        fx: { copAmountCents: "500000" },
      },
    };
    const result = extractArqMeta(rawData);
    expect(result!.recipientName).toBe("Statement Name");
  });

  it("handles missing copAmountCents gracefully", () => {
    const rawData = { arq: { recipient_name: "Someone" }, fx: {} };
    const result = extractArqMeta(rawData);
    expect(result!.copAmountCents).toBeNull();
  });
});
