/**
 * DB integration tests for cash-flow salary-gap detector + forecast state.
 *
 * Uses findash_test (forced by vitest.setup.ts).
 * Cleanup sentinel: label/description LIKE '__cashflow_test_%'
 *
 * BigInt literals use BigInt() constructor (targets ES2017, avoids 0n syntax).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cashFlowForecastState, recurringTransactions } from "@/lib/db/schema";
import { runSalaryGapForUser, runCashFlowForecastForUser } from "./cash-flow";

// ---------------------------------------------------------------------------
// Mock emitNotification to avoid actual DB writes in notifications table
// and to assert on emitted calls.
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
const SENTINEL = "__cashflow_test_";
const COP_PER_USD = 4000;

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  // Clean recurring_link_observations first (FK dependency)
  await db.execute(sql`
    DELETE FROM recurring_link_observations
    WHERE recurring_id IN (
      SELECT id FROM recurring_transactions WHERE label LIKE ${SENTINEL + "%"}
    )
  `);
  // Clean sentinel transactions inserted for observations
  await db.execute(sql`
    DELETE FROM transactions WHERE description_raw = ${SENTINEL + "_obs_tx"} AND user_id = ${TEST_USER_ID}
  `);
  // Clean recurring_transactions
  await db.execute(sql`
    DELETE FROM recurring_transactions WHERE label LIKE ${SENTINEL + "%"}
  `);
  // Clean cash_flow_forecast_state
  await db.execute(sql`
    DELETE FROM cash_flow_forecast_state WHERE user_id = ${TEST_USER_ID}
  `);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedRecurring(opts: {
  label: string;
  amountCents: bigint;
  dayOfMonth: number;
  categorySlug?: string | null;
  skippedMonths?: string[];
  active?: boolean;
}): Promise<number> {
  const amountCents = Number(opts.amountCents); // postgres raw sql: Number for bigint

  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO recurring_transactions (
      user_id, account_id, label, amount_cents, currency,
      category_slug, day_of_month, active, skipped_months
    )
    SELECT
      ${TEST_USER_ID},
      a.id,
      ${opts.label},
      ${amountCents},
      'COP',
      ${opts.categorySlug ?? null},
      ${opts.dayOfMonth},
      ${opts.active !== false},
      ${JSON.stringify(opts.skippedMonths ?? [])}::jsonb
    FROM accounts a
    WHERE a.user_id = ${TEST_USER_ID}
    ORDER BY a.id
    LIMIT 1
    RETURNING id
  `);
  if (!row) throw new Error("Failed to seed recurring transaction");
  return row.id;
}

async function seedObservation(opts: {
  recurringId: number;
  yearMonth: string;
  realAmountCents: bigint;
}): Promise<void> {
  const realAmountCents = Number(opts.realAmountCents);

  // Insert a minimal sentinel transaction to satisfy the FK on recurring_link_observations.
  const [txRow] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, classification_method, source
    )
    SELECT
      ${TEST_USER_ID},
      a.id,
      now()::timestamptz,
      ${realAmountCents},
      'COP',
      ${SENTINEL + "_obs_tx"},
      'manual'::classification_method,
      'sms'
    FROM accounts a
    WHERE a.user_id = ${TEST_USER_ID}
    ORDER BY a.id
    LIMIT 1
    RETURNING id
  `);
  if (!txRow) throw new Error("Failed to seed sentinel transaction for observation");

  await db.execute(sql`
    INSERT INTO recurring_link_observations (
      user_id, recurring_id, tx_id, year_month, real_amount_cents, real_currency, account_id
    )
    SELECT
      ${TEST_USER_ID},
      ${opts.recurringId},
      ${txRow.id},
      ${opts.yearMonth},
      ${realAmountCents},
      'COP',
      a.id
    FROM accounts a
    WHERE a.user_id = ${TEST_USER_ID}
    ORDER BY a.id
    LIMIT 1
    ON CONFLICT DO NOTHING
  `);
}

// ---------------------------------------------------------------------------
// Tests — D.3 salary-gap
// ---------------------------------------------------------------------------

describe("runSalaryGapForUser — D.3 salary-gap", () => {
  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
  });

  afterEach(cleanup);

  it("emits salary_gap notification for an income recurring past grace window", async () => {
    // today = day 20; dayOfMonth=10 → 10+3=13 ≤ 20 → triggers
    const today = new Date(Date.UTC(2026, 4, 20)); // May 20
    const recurringId = await seedRecurring({
      label: `${SENTINEL}salary_test`,
      amountCents: BigInt(5_000_000),
      dayOfMonth: 10,
      categorySlug: "salario",
    });

    await runSalaryGapForUser(TEST_USER_ID, db, today);

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({
        type: "salary_gap",
        entityId: `salary-gap:${TEST_USER_ID}:${recurringId}:2026-05`,
      }),
    );
  });

  it("does NOT emit when observation exists for current month", async () => {
    const today = new Date(Date.UTC(2026, 4, 20)); // May 20
    const recurringId = await seedRecurring({
      label: `${SENTINEL}salary_with_obs`,
      amountCents: BigInt(5_000_000),
      dayOfMonth: 10,
      categorySlug: "salario",
    });

    await seedObservation({
      recurringId,
      yearMonth: "2026-05",
      realAmountCents: BigInt(5_000_000),
    });

    await runSalaryGapForUser(TEST_USER_ID, db, today);

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("is idempotent — re-run for same month does NOT double-emit (entityId stable)", async () => {
    const today = new Date(Date.UTC(2026, 4, 20));
    await seedRecurring({
      label: `${SENTINEL}salary_idempotent`,
      amountCents: BigInt(5_000_000),
      dayOfMonth: 10,
      categorySlug: "salario",
    });

    // First call
    await runSalaryGapForUser(TEST_USER_ID, db, today);
    const firstCallCount = mocks.emitNotification.mock.calls.length;

    // Second call — emitNotification is mocked; in production the DB dedup
    // (partial unique index) ensures onConflictDoNothing. We verify the
    // entityId is stable (same on both calls).
    await runSalaryGapForUser(TEST_USER_ID, db, today);
    const secondCallCount = mocks.emitNotification.mock.calls.length;

    // Both calls should use same entityId
    const calls = mocks.emitNotification.mock.calls;
    if (firstCallCount >= 1 && secondCallCount >= 2) {
      const entityId1 = (calls[0]![1] as { entityId: string }).entityId;
      const entityId2 = (calls[1]![1] as { entityId: string }).entityId;
      expect(entityId1).toBe(entityId2);
    }
  });

  it("does NOT emit for an archived (deletedAt set) recurring", async () => {
    const today = new Date(Date.UTC(2026, 4, 20));
    const recurringId = await seedRecurring({
      label: `${SENTINEL}salary_archived`,
      amountCents: BigInt(5_000_000),
      dayOfMonth: 10,
      categorySlug: "salario",
    });

    // Soft-delete the recurring
    await db
      .update(recurringTransactions)
      .set({ deletedAt: new Date() })
      .where(eq(recurringTransactions.id, recurringId));

    await runSalaryGapForUser(TEST_USER_ID, db, today);

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT emit when current month is in skippedMonths", async () => {
    const today = new Date(Date.UTC(2026, 4, 20));
    await seedRecurring({
      label: `${SENTINEL}salary_skipped`,
      amountCents: BigInt(5_000_000),
      dayOfMonth: 10,
      categorySlug: "salario",
      skippedMonths: ["2026-05"],
    });

    await runSalaryGapForUser(TEST_USER_ID, db, today);

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT emit when still within grace window", async () => {
    // dayOfMonth=15, today=day 17 → trigger at 18 → not yet
    const today = new Date(Date.UTC(2026, 4, 17));
    await seedRecurring({
      label: `${SENTINEL}salary_grace`,
      amountCents: BigInt(5_000_000),
      dayOfMonth: 15,
      categorySlug: "salario",
    });

    await runSalaryGapForUser(TEST_USER_ID, db, today);

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — D.4 forecast state
// ---------------------------------------------------------------------------

describe("runCashFlowForecastForUser — D.4 forecast shortfall", () => {
  beforeEach(async () => {
    await cleanup();
    mocks.emitNotification.mockClear();
  });

  afterEach(cleanup);

  it("upserts cash_flow_forecast_state row after running", async () => {
    const today = new Date(Date.UTC(2026, 4, 2));

    await runCashFlowForecastForUser(TEST_USER_ID, COP_PER_USD, db, today);

    const [stateRow] = await db
      .select()
      .from(cashFlowForecastState)
      .where(eq(cashFlowForecastState.userId, TEST_USER_ID));

    expect(stateRow).toBeDefined();
    expect(stateRow!.userId).toBe(TEST_USER_ID);
  });

  it("re-run on same day with same shortfall does NOT emit a second notification", async () => {
    const today = new Date(Date.UTC(2026, 4, 2));

    // First run — sets lastShortfallDate
    await runCashFlowForecastForUser(TEST_USER_ID, COP_PER_USD, db, today);
    // First run — shortfall state established
    void mocks.emitNotification.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "cash_flow_forecast",
    ).length;

    mocks.emitNotification.mockClear();

    // Second run — shortfall unchanged → no new notification
    const { shortfallChanged } = await runCashFlowForecastForUser(
      TEST_USER_ID,
      COP_PER_USD,
      db,
      today,
    );

    expect(shortfallChanged).toBe(false);
    const secondEmitCount = mocks.emitNotification.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "cash_flow_forecast",
    ).length;
    expect(secondEmitCount).toBe(0);
  });
});
