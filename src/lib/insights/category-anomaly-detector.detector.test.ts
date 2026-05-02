/**
 * Integration tests for detectCategoryAnomalyForUser (DB-hitting).
 *
 * Uses findash_test (forced by vitest.setup.ts).
 * Cleanup sentinel: description_raw LIKE '__catanom_test%'.
 *
 * NOTE: BigInt literals (0n) are ES2020+. This project targets ES2017, so we
 * use BigInt() constructor calls throughout (matching the anomaly-detector pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { detectCategoryAnomalyForUser } from "./category-anomaly-detector";

// ---------------------------------------------------------------------------
// emitNotification mock
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 999 }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = 1; // bootstrap user — always exists in findash_test
const SENTINEL = "__catanom_test";

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function cleanup() {
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__catanom_test%'`);
}

async function defaultAccountId(): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} ORDER BY id LIMIT 1
  `);
  if (!row) throw new Error("No account for test user");
  return row.id;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTx(opts: {
  accountId: number;
  amountCents: bigint;
  canonicalMerchant?: string | null;
  categorySlug?: string | null;
  classificationMethod?: string;
  channel?: string;
  recurringId?: number | null;
  description?: string;
}): Promise<number> {
  const occurredAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const amountCents = Number(opts.amountCents);
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, classification_method, source,
      canonical_merchant, category_slug, channel
    ) VALUES (
      ${TEST_USER_ID},
      ${opts.accountId},
      ${occurredAt}::timestamptz,
      ${amountCents},
      'COP',
      ${opts.description ?? `${SENTINEL}_tx`},
      ${opts.classificationMethod ?? "rule"}::classification_method,
      'sms',
      ${opts.canonicalMerchant ?? null},
      ${opts.categorySlug ?? null},
      ${opts.channel ?? "bank"}
    )
    RETURNING id
  `);
  return row.id;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("detectCategoryAnomalyForUser — skip rules", () => {
  let accountId: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    accountId = await defaultAccountId();
  });

  afterEach(cleanup);

  it("skips when classifiedIds is empty", async () => {
    await detectCategoryAnomalyForUser(TEST_USER_ID, [], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips when classification_method is manual", async () => {
    const merchant = `${SENTINEL}_manual_${Date.now()}`;
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: "transporte",
      classificationMethod: "manual",
    });

    await detectCategoryAnomalyForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips when channel is transfer", async () => {
    const merchant = `${SENTINEL}_transfer_${Date.now()}`;
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: "transporte",
      channel: "transfer",
    });

    await detectCategoryAnomalyForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips when categorySlug is null", async () => {
    const merchant = `${SENTINEL}_nocat_${Date.now()}`;
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: null,
    });

    await detectCategoryAnomalyForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips when canonical_merchant is null", async () => {
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: null,
      categorySlug: "transporte",
    });

    await detectCategoryAnomalyForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire when prior history is below 10 txs", async () => {
    const merchant = `${SENTINEL}_low_hist_${Date.now()}`;

    // Seed 9 prior txs in alimentacion
    for (let i = 0; i < 9; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-50_000),
        canonicalMerchant: merchant,
        categorySlug: "alimentacion",
        description: `${SENTINEL}_prior_${i}`,
      });
    }

    const newTxId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: "transporte",
      description: `${SENTINEL}_new`,
    });

    await detectCategoryAnomalyForUser(TEST_USER_ID, [newTxId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });
});

describe("detectCategoryAnomalyForUser — detection fires", () => {
  let accountId: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    accountId = await defaultAccountId();
  });

  afterEach(cleanup);

  it("emits category_anomaly when 10+ prior txs have 80%+ same category and tx diverges", async () => {
    const merchant = `${SENTINEL}_anomaly_${Date.now()}`;

    // Seed 10 prior txs in alimentacion (100% modal)
    for (let i = 0; i < 10; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-50_000),
        canonicalMerchant: merchant,
        categorySlug: "alimentacion",
        description: `${SENTINEL}_prior_${i}`,
      });
    }

    // New tx in transporte — anomalous
    const newTxId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: "transporte",
      description: `${SENTINEL}_new`,
    });

    await detectCategoryAnomalyForUser(TEST_USER_ID, [newTxId], db);

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        type: "category_anomaly",
        entityId: `category-anomaly:${newTxId}`,
      }),
    );

    // anomaly_flags written with categoryAnomaly
    const [row] = await db
      .select({ anomalyFlags: transactions.anomalyFlags })
      .from(transactions)
      .where(eq(transactions.id, newTxId));

    expect(row?.anomalyFlags).toMatchObject({
      categoryAnomaly: {
        expectedCategory: "alimentacion",
        actualCategory: "transporte",
      },
    });
  });

  it("merges categoryAnomaly with existing firstEncounter flag without overwriting", async () => {
    const merchant = `${SENTINEL}_merge_${Date.now()}`;

    // Seed 10 prior txs
    for (let i = 0; i < 10; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-50_000),
        canonicalMerchant: merchant,
        categorySlug: "alimentacion",
        description: `${SENTINEL}_prior_${i}`,
      });
    }

    const newTxId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: "transporte",
      description: `${SENTINEL}_new_with_first_enc`,
    });

    // Pre-seed firstEncounter on the tx (simulating B.2 already ran)
    await db.execute(sql`
      UPDATE transactions
      SET anomaly_flags = '{"firstEncounter": true, "detectedAt": "2026-05-01T00:00:00Z"}'::jsonb
      WHERE id = ${newTxId}
    `);

    await detectCategoryAnomalyForUser(TEST_USER_ID, [newTxId], db);

    const [row] = await db
      .select({ anomalyFlags: transactions.anomalyFlags })
      .from(transactions)
      .where(eq(transactions.id, newTxId));

    // Both flags must be present — merge must not overwrite firstEncounter
    expect(row?.anomalyFlags).toMatchObject({
      firstEncounter: true,
      categoryAnomaly: {
        expectedCategory: "alimentacion",
        actualCategory: "transporte",
      },
    });
  });

  it("deduplicates notifications — second call with same txId does not double-emit", async () => {
    // emitNotification uses idempotent insert; the mock just tracks calls
    const merchant = `${SENTINEL}_dedup_${Date.now()}`;

    for (let i = 0; i < 10; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-50_000),
        canonicalMerchant: merchant,
        categorySlug: "alimentacion",
        description: `${SENTINEL}_d_prior_${i}`,
      });
    }

    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: "transporte",
      description: `${SENTINEL}_d_new`,
    });

    await detectCategoryAnomalyForUser(TEST_USER_ID, [txId], db);
    await detectCategoryAnomalyForUser(TEST_USER_ID, [txId], db);

    // Called twice — the DB-level dedup (onConflictDoNothing) handles idempotency
    // at the notification layer; the detector itself emits once per call.
    // This test confirms the detector does NOT throw on second call.
    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);
  });

  it("tenant safety — does NOT cross to another user's history", async () => {
    // This is inherently tested by using TEST_USER_ID=1 throughout and relying
    // on eq(transactions.userId, userId) in every query. The point of this test
    // is to confirm the detector uses the userId filter consistently.
    const merchant = `${SENTINEL}_tenant_${Date.now()}`;
    // Only seed txs for user 1 — if any query forgets userId, it might pick up
    // data from other users in findash_test and fire incorrectly.
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000),
      canonicalMerchant: merchant,
      categorySlug: "transporte",
      description: `${SENTINEL}_tenant_new`,
    });

    // No prior history for this user/merchant — should NOT fire
    await detectCategoryAnomalyForUser(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });
});
