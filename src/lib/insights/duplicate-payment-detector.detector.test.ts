/**
 * Integration tests for detectDuplicatePaymentForUser (DB-hitting).
 *
 * Uses findash_test (forced by vitest.setup.ts).
 * Cleanup sentinel: description_raw LIKE '__duppay_test%'.
 *
 * NOTE: BigInt literals (0n) are ES2020+. Use BigInt() constructor throughout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { detectDuplicatePaymentForUser } from "./duplicate-payment-detector";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 999 }),
  getCurrentFxRate: vi.fn().mockResolvedValue({ rate: 4000, source: "test" }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

vi.mock("@/lib/fx/repo", () => ({
  getCurrentFxRate: mocks.getCurrentFxRate,
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = 1;
const SENTINEL = "__duppay_test";

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function cleanup() {
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__duppay_test%'`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE '__duppay_test%'`);
}

async function getAccountIds(): Promise<{ accountA: number; accountB: number }> {
  const rows = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} ORDER BY id LIMIT 2
  `);
  if (rows.length < 2) throw new Error("Need at least 2 accounts for test user");
  return { accountA: rows[0]!.id, accountB: rows[1]!.id };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTx(opts: {
  accountId: number;
  amountCents: bigint;
  canonicalMerchant?: string | null;
  channel?: string;
  recurringId?: number | null;
  daysAgo?: number;
  description?: string;
}): Promise<number> {
  const occurredAt = new Date(Date.now() - (opts.daysAgo ?? 1) * 24 * 60 * 60 * 1000).toISOString();
  const amountCents = Number(opts.amountCents);
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, classification_method, source,
      canonical_merchant, channel
    ) VALUES (
      ${TEST_USER_ID},
      ${opts.accountId},
      ${occurredAt}::timestamptz,
      ${amountCents},
      'COP',
      ${opts.description ?? `${SENTINEL}_tx`},
      'rule'::classification_method,
      'sms',
      ${opts.canonicalMerchant ?? null},
      ${opts.channel ?? "bank"}
    )
    RETURNING id
  `);
  return row.id;
}

async function setRecurringId(txId: number, recurringId: number) {
  await db.execute(sql`
    UPDATE transactions SET recurring_id = ${recurringId} WHERE id = ${txId}
  `);
}

/**
 * Seeds a minimal synthetic recurring_transactions row.
 * Returns its id so tests can link transactions to it.
 */
async function seedRecurring(accountId: number): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO recurring_transactions (
      user_id, account_id, label, amount_cents, currency, day_of_month, active, amount_type
    ) VALUES (
      ${TEST_USER_ID},
      ${accountId},
      ${"__duppay_test_recurring"},
      ${-50000},
      'COP',
      1,
      true,
      'fixed'
    )
    RETURNING id
  `);
  return row.id;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("detectDuplicatePaymentForUser — skip rules", () => {
  let accountA: number;
  let accountB: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    const ids = await getAccountIds();
    accountA = ids.accountA;
    accountB = ids.accountB;
  });

  afterEach(cleanup);

  it("skips when classifiedIds is empty", async () => {
    await detectDuplicatePaymentForUser(TEST_USER_ID, [], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips when canonical_merchant is null", async () => {
    const txId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: null,
      description: `${SENTINEL}_no_merchant`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips income txs (amount_cents > 0)", async () => {
    const merchant = `${SENTINEL}_income_${Date.now()}`;
    const txId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(50_000), // positive
      canonicalMerchant: merchant,
      description: `${SENTINEL}_income_new`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips transfer channel", async () => {
    const merchant = `${SENTINEL}_transfer_${Date.now()}`;
    const txId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      channel: "transfer",
      description: `${SENTINEL}_transfer_new`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire when NEITHER tx has a recurring_id", async () => {
    // Both one-off — fails the recurring requirement
    const merchant = `${SENTINEL}_norecurring_${Date.now()}`;

    const existingId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      daysAgo: 10,
      description: `${SENTINEL}_norecurring_existing`,
    });
    // No recurring_id on either

    const newId = await seedTx({
      accountId: accountB,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      description: `${SENTINEL}_norecurring_new`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [newId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();

    void existingId; // suppress unused warning
  });
});

describe("detectDuplicatePaymentForUser — detection fires", () => {
  let accountA: number;
  let accountB: number;
  let recurringId: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    const ids = await getAccountIds();
    accountA = ids.accountA;
    accountB = ids.accountB;
    // Seed a synthetic recurring row — guarantees recurring_id IS NOT NULL
    // prerequisite without depending on findash_test seed state.
    recurringId = await seedRecurring(accountA);
  });

  afterEach(cleanup);

  it("fires when new tx matches existing tx on different account with recurring on existing", async () => {
    const merchant = `${SENTINEL}_fire_existing_rec_${Date.now()}`;

    const existingId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      daysAgo: 15,
      description: `${SENTINEL}_existing_rec`,
    });

    await setRecurringId(existingId, recurringId);

    const newId = await seedTx({
      accountId: accountB,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      description: `${SENTINEL}_new_no_rec`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [newId], db);

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        type: "duplicate_payment",
        entityId: expect.stringContaining(`dup-payment:${TEST_USER_ID}:${merchant}`),
      }),
    );

    // anomaly_flags written on new tx
    const [row] = await db
      .select({ anomalyFlags: transactions.anomalyFlags })
      .from(transactions)
      .where(eq(transactions.id, newId));

    expect(row?.anomalyFlags).toMatchObject({
      duplicatePayment: {
        pairedTxId: existingId,
        otherAccountId: accountA,
      },
    });
  });

  it("fires when new tx has recurring_id (pair requirement met by new side)", async () => {
    const merchant = `${SENTINEL}_fire_new_rec_${Date.now()}`;

    const existingId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      daysAgo: 5,
      description: `${SENTINEL}_existing_no_rec`,
    });

    const newId = await seedTx({
      accountId: accountB,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      description: `${SENTINEL}_new_with_rec`,
    });

    await setRecurringId(newId, recurringId);

    await detectDuplicatePaymentForUser(TEST_USER_ID, [newId], db);

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ type: "duplicate_payment" }),
    );

    void existingId;
  });

  it("does NOT fire when amounts differ by more than 5%", async () => {
    const merchant = `${SENTINEL}_amt_diff_${Date.now()}`;

    const existingId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-100_000),
      canonicalMerchant: merchant,
      daysAgo: 5,
      description: `${SENTINEL}_existing_diff`,
    });

    await setRecurringId(existingId, recurringId);

    const newId = await seedTx({
      accountId: accountB,
      amountCents: BigInt(-90_000), // 10% different → outside 5% tolerance
      canonicalMerchant: merchant,
      description: `${SENTINEL}_new_diff`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [newId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();

    void existingId;
  });

  it("does NOT fire when both txs are on the same account", async () => {
    const merchant = `${SENTINEL}_same_acct_${Date.now()}`;

    const existingId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      daysAgo: 5,
      description: `${SENTINEL}_existing_same`,
    });

    await setRecurringId(existingId, recurringId);

    const newId = await seedTx({
      accountId: accountA, // same account
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      description: `${SENTINEL}_new_same`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [newId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();

    void existingId;
  });

  it("does NOT fire when existing tx is beyond the 35-day window", async () => {
    const merchant = `${SENTINEL}_window_${Date.now()}`;

    const existingId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      daysAgo: 40, // well beyond 35-day window (new tx is daysAgo:1, so cutoff ≈ now-36d)
      description: `${SENTINEL}_existing_old`,
    });

    await setRecurringId(existingId, recurringId);

    const newId = await seedTx({
      accountId: accountB,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      description: `${SENTINEL}_new_after_window`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [newId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();

    void existingId;
  });
});

describe("detectDuplicatePaymentForUser — tenant safety", () => {
  let accountA: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    const ids = await getAccountIds();
    accountA = ids.accountA;
  });

  afterEach(cleanup);

  it("does not cross-contaminate with data from other users", async () => {
    // Only one tx for user 1 — no prior history on a DIFFERENT account.
    // If the query forgot userId, it might find data from other users.
    const merchant = `${SENTINEL}_tenant_${Date.now()}`;
    const txId = await seedTx({
      accountId: accountA,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      description: `${SENTINEL}_tenant_only`,
    });

    await detectDuplicatePaymentForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });
});
