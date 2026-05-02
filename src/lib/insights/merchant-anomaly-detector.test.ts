/**
 * Integration tests for detectMerchantSignals (DB-hitting).
 *
 * Uses findash_test (forced by vitest.setup.ts).
 * Cleanup sentinel: description_raw LIKE '__anomaly_test%'.
 *
 * NOTE: BigInt literals (0n) are ES2020+. This project targets ES2017, so we
 * use BigInt() constructor calls throughout (matching the tc-health.test.ts pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { detectMerchantSignals } from "./merchant-anomaly";

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
const SENTINEL = "__anomaly_test";

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function cleanup() {
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__anomaly_test%'`);
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
  currency?: string;
  canonicalMerchant?: string | null;
  channel?: string;
  occurredDaysAgo?: number; // relative to now; default=1
  description?: string;
}): Promise<number> {
  const occurredAt = new Date(
    Date.now() - (opts.occurredDaysAgo ?? 1) * 24 * 60 * 60 * 1000,
  ).toISOString(); // postgres.js raw sql requires ISO string, not Date object
  const amountCents = Number(opts.amountCents); // postgres.js raw sql: use Number for bigint
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
      ${opts.currency ?? "COP"},
      ${opts.description ?? `${SENTINEL}_tx`},
      'manual'::classification_method,
      'sms',
      ${opts.canonicalMerchant ?? null},
      ${opts.channel ?? "bank"}
    )
    RETURNING id
  `);
  return row.id;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("detectMerchantSignals — skip rules", () => {
  let accountId: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    accountId = await defaultAccountId();
  });

  afterEach(cleanup);

  it("skips transactions with null canonical_merchant", async () => {
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-30_000),
      canonicalMerchant: null,
    });

    await detectMerchantSignals(TEST_USER_ID, [txId], db);

    expect(mocks.emitNotification).not.toHaveBeenCalled();

    // anomaly_flags must remain null
    const [row] = await db
      .select({ anomalyFlags: transactions.anomalyFlags })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row?.anomalyFlags).toBeNull();
  });

  it("skips transfer transactions", async () => {
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-30_000),
      canonicalMerchant: `${SENTINEL}_merchant`,
      channel: "transfer",
    });

    await detectMerchantSignals(TEST_USER_ID, [txId], db);

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips non-expense transactions (amount_cents >= 0)", async () => {
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(10_000), // positive = income
      canonicalMerchant: `${SENTINEL}_income_merchant`,
    });

    await detectMerchantSignals(TEST_USER_ID, [txId], db);

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("skips if classifiedIds is empty", async () => {
    await detectMerchantSignals(TEST_USER_ID, [], db);
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });
});

describe("detectMerchantSignals — B.2 first-encounter", () => {
  let accountId: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    accountId = await defaultAccountId();
  });

  afterEach(cleanup);

  it("emits first_encounter notification on a brand-new merchant", async () => {
    const merchant = `${SENTINEL}_new_merchant_${Date.now()}`;
    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-15_000),
      canonicalMerchant: merchant,
    });

    await detectMerchantSignals(TEST_USER_ID, [txId], db);

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        type: "merchant_first_encounter",
        entityId: `first-merchant:${TEST_USER_ID}:${merchant}`,
      }),
    );

    // Check anomaly_flags written to the tx
    const [row] = await db
      .select({ anomalyFlags: transactions.anomalyFlags })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row?.anomalyFlags).toMatchObject({ firstEncounter: true });
  });

  it("does NOT emit first_encounter for the second tx of the same merchant", async () => {
    const merchant = `${SENTINEL}_repeat_merchant_${Date.now()}`;

    // Seed the first tx ONLY first, then process it so it's the true first-encounter
    const tx1 = await seedTx({
      accountId,
      amountCents: BigInt(-15_000),
      canonicalMerchant: merchant,
      occurredDaysAgo: 5,
    });

    // Process first tx alone — should emit first_encounter (no prior history for merchant)
    await detectMerchantSignals(TEST_USER_ID, [tx1], db);
    expect(mocks.emitNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ type: "merchant_first_encounter" }),
    );

    mocks.emitNotification.mockClear();

    // NOW seed the second tx (merchant now has 1 prior: tx1)
    const tx2 = await seedTx({
      accountId,
      amountCents: BigInt(-15_000),
      canonicalMerchant: merchant,
      occurredDaysAgo: 1,
    });

    // Process second tx — history=1, so no first-encounter; history < 5 so no anomaly either
    await detectMerchantSignals(TEST_USER_ID, [tx2], db);
    expect(mocks.emitNotification).not.toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ type: "merchant_first_encounter" }),
    );
    expect(mocks.emitNotification).not.toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ type: "merchant_anomaly" }),
    );
  });
});

describe("detectMerchantSignals — B.1 anomaly", () => {
  let accountId: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    accountId = await defaultAccountId();
  });

  afterEach(cleanup);

  it("emits anomaly notification when 6th tx breaks 3× threshold with delta >= 10k", async () => {
    const merchant = `${SENTINEL}_anomaly_merchant_${Date.now()}`;

    // Seed 5 prior transactions at 10_000 each within 30-day window
    for (let i = 0; i < 5; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-10_000),
        canonicalMerchant: merchant,
        occurredDaysAgo: 25 - i, // within 30-day window
        description: `${SENTINEL}_baseline_${i}`,
      });
    }

    // 6th tx at 35_000 (3.5× avg=10k, delta=25k)
    const anomalousTxId = await seedTx({
      accountId,
      amountCents: BigInt(-35_000),
      canonicalMerchant: merchant,
      occurredDaysAgo: 1,
      description: `${SENTINEL}_anomalous`,
    });

    await detectMerchantSignals(TEST_USER_ID, [anomalousTxId], db);

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        type: "merchant_anomaly",
        entityId: `anomaly:${anomalousTxId}`,
      }),
    );

    // Check anomaly_flags written
    const [row] = await db
      .select({ anomalyFlags: transactions.anomalyFlags })
      .from(transactions)
      .where(eq(transactions.id, anomalousTxId));
    expect(row?.anomalyFlags).toMatchObject({
      anomaly: expect.objectContaining({
        factor: expect.any(Number),
        deltaCents: expect.any(String),
        baselineAvgCents: "10000",
      }),
    });
  });

  it("does NOT fire anomaly when only 4 prior txs (< ANOMALY_MIN_HISTORY=5)", async () => {
    const merchant = `${SENTINEL}_insufficient_history_${Date.now()}`;

    // Only 4 prior txs — below minimum
    for (let i = 0; i < 4; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-10_000),
        canonicalMerchant: merchant,
        occurredDaysAgo: 20 - i,
        description: `${SENTINEL}_hist_${i}`,
      });
    }

    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-50_000), // 5× avg — would fire if history were sufficient
      canonicalMerchant: merchant,
      occurredDaysAgo: 1,
      description: `${SENTINEL}_check`,
    });

    await detectMerchantSignals(TEST_USER_ID, [txId], db);

    // Should not emit anomaly (insufficient history; 4 priors > 0 so also not first-encounter)
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("currency split: COP history does NOT contaminate USD anomaly check", async () => {
    const merchant = `${SENTINEL}_multicurrency_merchant_${Date.now()}`;

    // Seed 5 COP transactions at 10_000 COP each
    for (let i = 0; i < 5; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-10_000),
        currency: "COP",
        canonicalMerchant: merchant,
        occurredDaysAgo: 20 - i,
        description: `${SENTINEL}_cop_${i}`,
      });
    }

    // New USD tx — this merchant has 5 COP entries but 0 USD entries in the window.
    // Full history count = 5, so not first-encounter.
    // USD window history = 0 (< ANOMALY_MIN_HISTORY), so anomaly should NOT fire.
    const usdTxId = await seedTx({
      accountId,
      amountCents: BigInt(-5_000),
      currency: "USD",
      canonicalMerchant: merchant,
      occurredDaysAgo: 1,
      description: `${SENTINEL}_usd`,
    });

    await detectMerchantSignals(TEST_USER_ID, [usdTxId], db);

    // COP history should NOT bleed into USD check
    expect(mocks.emitNotification).not.toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ type: "merchant_anomaly" }),
    );
    // Also not first-encounter (has 5 prior COP txs in full history)
    expect(mocks.emitNotification).not.toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ type: "merchant_first_encounter" }),
    );
  });
});

describe("detectMerchantSignals — dedup (anomaly entityId is stable)", () => {
  let accountId: number;

  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
    accountId = await defaultAccountId();
  });

  afterEach(cleanup);

  it("calling detectMerchantSignals twice for same anomalous tx uses stable entityId", async () => {
    const merchant = `${SENTINEL}_dedup_merchant_${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      await seedTx({
        accountId,
        amountCents: BigInt(-10_000),
        canonicalMerchant: merchant,
        occurredDaysAgo: 20 - i,
        description: `${SENTINEL}_dedup_hist_${i}`,
      });
    }

    const txId = await seedTx({
      accountId,
      amountCents: BigInt(-40_000),
      canonicalMerchant: merchant,
      occurredDaysAgo: 1,
      description: `${SENTINEL}_dedup_anomalous`,
    });

    // First call
    await detectMerchantSignals(TEST_USER_ID, [txId], db);
    expect(mocks.emitNotification).toHaveBeenCalledTimes(1);

    // Second call — emitNotification is mocked; in prod onConflictDoNothing handles dedup
    mocks.emitNotification.mockResolvedValueOnce(null); // simulate dedup return
    await detectMerchantSignals(TEST_USER_ID, [txId], db);

    // Both calls should use the SAME entityId so DB dedup works correctly
    const calls = mocks.emitNotification.mock.calls;
    const entityIds = calls.map((c) => (c[1] as { entityId: string }).entityId);
    expect(entityIds[0]).toBe(entityIds[1]);
    expect(entityIds[0]).toBe(`anomaly:${txId}`);
  });
});
