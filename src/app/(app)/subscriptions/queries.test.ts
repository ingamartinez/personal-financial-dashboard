import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { recurringTransactions } from "@/lib/db/schema";

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const { computeNextOccurrence, getSubscriptions } = await import("./queries");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_LABEL_PREFIX = "__test_sub_";
const SUSCRIPCIONES_SLUG = "suscripciones";

async function getAccountId(userId: number): Promise<number> {
  const [acc] = await db.execute<{ id: number }>(
    sql`SELECT id FROM accounts WHERE user_id = ${userId} LIMIT 1`,
  );
  if (!acc) throw new Error(`No seed account for user ${userId}`);
  return acc.id;
}

async function ensureSuscripcionesCategory(userId: number): Promise<void> {
  // Insert suscripciones category if not present (it should be from seed, but
  // test DB may differ — upsert to be safe).
  await db.execute(sql`
    INSERT INTO categories (user_id, slug, name, parent_slug, sort_order)
    VALUES (${userId}, 'suscripciones', 'Suscripciones', 'gastos-fijos', 10)
    ON CONFLICT (user_id, slug) DO NOTHING
  `);
}

async function insertRecurring(
  userId: number,
  accountId: number,
  overrides: Partial<{
    label: string;
    amountCents: bigint;
    currency: string;
    categorySlug: string | null;
    dayOfMonth: number;
    active: boolean;
    amountType: string;
    skippedMonths: string[];
  }> = {},
) {
  const label = overrides.label ?? `${TEST_LABEL_PREFIX}${Date.now()}`;
  const [row] = await db
    .insert(recurringTransactions)
    .values({
      userId,
      accountId,
      label,
      amountCents: overrides.amountCents ?? BigInt(-150_000),
      currency: (overrides.currency ?? "COP") as "COP" | "USD",
      categorySlug:
        overrides.categorySlug !== undefined ? overrides.categorySlug : SUSCRIPCIONES_SLUG,
      dayOfMonth: overrides.dayOfMonth ?? 15,
      active: overrides.active !== undefined ? overrides.active : true,
      amountType: (overrides.amountType ?? "fixed") as "fixed" | "variable",
      skippedMonths: overrides.skippedMonths ?? [],
    })
    .returning({ id: recurringTransactions.id });
  return row!;
}

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_transactions WHERE label LIKE ${TEST_LABEL_PREFIX + "%"}`,
  );
  // Remove test users created inline for tenant-isolation tests (and their
  // dependent rows). ON CONFLICT upserts by email, so the rows survive across
  // runs and contaminate sloOnboardingTime + sloClassificationRate (which have
  // no user_id filter) on subsequent runs.
  //
  // Order matters: delete FK children before parents.
  //   transactions → accounts → (categories, users)
  await db.execute(sql`
    DELETE FROM transactions WHERE user_id IN (
      SELECT id FROM users WHERE email LIKE ${TEST_LABEL_PREFIX + "%"}
    )
  `);
  await db.execute(sql`
    DELETE FROM accounts WHERE user_id IN (
      SELECT id FROM users WHERE email LIKE ${TEST_LABEL_PREFIX + "%"}
    )
  `);
  await db.execute(sql`
    DELETE FROM categories WHERE user_id IN (
      SELECT id FROM users WHERE email LIKE ${TEST_LABEL_PREFIX + "%"}
    )
  `);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TEST_LABEL_PREFIX + "%"}`);
}

// ---------------------------------------------------------------------------
// computeNextOccurrence — pure unit tests (no DB)
// ---------------------------------------------------------------------------

describe("computeNextOccurrence", () => {
  it("returns this month when today.day <= dayOfMonth", () => {
    // today = May 10, dayOfMonth = 15 → next = 2026-05-15
    const today = new Date(Date.UTC(2026, 4, 10)); // May 10
    expect(computeNextOccurrence(15, [], today)).toBe("2026-05-15");
  });

  it("returns this month when today.day === dayOfMonth", () => {
    // today = May 15, dayOfMonth = 15 → next = 2026-05-15
    const today = new Date(Date.UTC(2026, 4, 15));
    expect(computeNextOccurrence(15, [], today)).toBe("2026-05-15");
  });

  it("returns next month when today.day > dayOfMonth", () => {
    // today = May 20, dayOfMonth = 15 → next = 2026-06-15
    const today = new Date(Date.UTC(2026, 4, 20));
    expect(computeNextOccurrence(15, [], today)).toBe("2026-06-15");
  });

  it("wraps to January when advancing past December", () => {
    // today = Dec 20, dayOfMonth = 5 → next = 2026-01-05
    const today = new Date(Date.UTC(2025, 11, 20)); // Dec 20 2025
    expect(computeNextOccurrence(5, [], today)).toBe("2026-01-05");
  });

  it("skips a month in skippedMonths and picks the next non-skipped month", () => {
    // today = May 10, dayOfMonth = 15 → candidate = 2026-05
    // 2026-05 is skipped → next = 2026-06-15
    const today = new Date(Date.UTC(2026, 4, 10));
    expect(computeNextOccurrence(15, ["2026-05"], today)).toBe("2026-06-15");
  });

  it("skips multiple consecutive skipped months", () => {
    // today = May 10, dayOfMonth = 1 → candidate = 2026-05
    // 2026-05 and 2026-06 are skipped → next = 2026-07-01
    const today = new Date(Date.UTC(2026, 4, 10));
    expect(computeNextOccurrence(1, ["2026-05", "2026-06"], today)).toBe("2026-07-01");
  });

  it("skippedMonths for a past month does not affect future calculation", () => {
    // today = May 10, dayOfMonth = 15 → candidate = 2026-05
    // 2026-04 (past) is skipped — irrelevant → next = 2026-05-15
    const today = new Date(Date.UTC(2026, 4, 10));
    expect(computeNextOccurrence(15, ["2026-04"], today)).toBe("2026-05-15");
  });
});

// ---------------------------------------------------------------------------
// getSubscriptions — integration tests (hit findash_test DB)
// ---------------------------------------------------------------------------

describe("getSubscriptions", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns only suscripciones-category rows for the requesting user", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const subLabel = `${TEST_LABEL_PREFIX}sub`;
    const otherLabel = `${TEST_LABEL_PREFIX}other`;

    // Insert one suscripciones recurring.
    await insertRecurring(1, accountId, { label: subLabel });
    // Insert one with a different (or null) category.
    await insertRecurring(1, accountId, {
      label: otherLabel,
      categorySlug: null,
    });

    const { rows } = await getSubscriptions(1, "native", 4200);

    const ids = rows.map((r) => r.label);
    expect(ids).toContain(subLabel);
    expect(ids).not.toContain(otherLabel);
  });

  it("excludes soft-deleted recurring rows", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}deleted`;
    const { id } = await insertRecurring(1, accountId, { label });

    // Soft-delete it.
    await db
      .update(recurringTransactions)
      .set({ deletedAt: new Date() })
      .where(eq(recurringTransactions.id, id));

    const { rows } = await getSubscriptions(1, "native", 4200);
    expect(rows.find((r) => r.label === label)).toBeUndefined();
  });

  it("excludes inactive (active=false) rows", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}inactive`;
    await insertRecurring(1, accountId, { label, active: false });

    const { rows } = await getSubscriptions(1, "native", 4200);
    expect(rows.find((r) => r.label === label)).toBeUndefined();
  });

  it("includes variable amountType rows with the flag", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}variable`;
    await insertRecurring(1, accountId, { label, amountType: "variable" });

    const { rows } = await getSubscriptions(1, "native", 4200);
    const found = rows.find((r) => r.label === label);
    expect(found).toBeDefined();
    expect(found!.amountType).toBe("variable");
  });

  it("tenant isolation: user 1 does not see user 2 rows", async () => {
    // Upsert a second user inline so this assertion ALWAYS runs even on fresh
    // test DBs that were seeded with only one user. Raw-SQL upsert avoids
    // importing the full signup flow (copyCategorySeedsToUser etc.) which is
    // out of scope here.
    const uniqueEmail = `${TEST_LABEL_PREFIX}user2@test.local`;
    const [user2Row] = await db.execute<{ id: number }>(sql`
      INSERT INTO users (email, name)
      VALUES (${uniqueEmail}, 'Tenant Test User 2')
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const user2Id = user2Row!.id;

    // Create an account for user 2 (needed for insertRecurring FK).
    const [acc2Row] = await db.execute<{ id: number }>(sql`
      INSERT INTO accounts (user_id, name, institution, type, currency)
      VALUES (${user2Id}, 'Test Account', 'Test Bank', 'savings', 'COP')
      RETURNING id
    `);
    const accountId2 = acc2Row!.id;

    // Ensure suscripciones category for user 2 as well.
    // Use NULL parent_slug to avoid needing the full category tree for this
    // test user — the FK only requires (user_id, parent_slug) to exist when
    // parent_slug IS NOT NULL.
    await db.execute(sql`
      INSERT INTO categories (user_id, slug, name, parent_slug, sort_order)
      VALUES (${user2Id}, 'suscripciones', 'Suscripciones', NULL, 10)
      ON CONFLICT (user_id, slug) DO NOTHING
    `);

    const label2 = `${TEST_LABEL_PREFIX}user2`;
    await insertRecurring(user2Id, accountId2, { label: label2 });

    const { rows } = await getSubscriptions(1, "native", 4200);
    expect(rows.find((r) => r.label === label2)).toBeUndefined();

    // Cleanup user-2 rows (users row will cascade on delete if needed, but
    // we only need to remove the recurring — cleanup() handles label-prefix rows).
    // The account and user are test-ephemeral; they'll be cleaned by the test DB reset.
  });

  it("computes annualCents as amountCents × 12", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}annual`;
    const amount = BigInt(-100_000);
    await insertRecurring(1, accountId, { label, amountCents: amount });

    const { rows } = await getSubscriptions(1, "native", 4200);
    const found = rows.find((r) => r.label === label);
    expect(found).toBeDefined();
    expect(found!.annualCents).toBe(amount * BigInt(12));
  });

  it("rows are sorted by dayOfMonth ascending; amount desc as tiebreaker", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const day5 = `${TEST_LABEL_PREFIX}day5`;
    const day10cheap = `${TEST_LABEL_PREFIX}day10cheap`;
    const day10expensive = `${TEST_LABEL_PREFIX}day10expensive`;
    const day20 = `${TEST_LABEL_PREFIX}day20`;
    await insertRecurring(1, accountId, {
      label: day20,
      amountCents: BigInt(-100_000),
      dayOfMonth: 20,
    });
    await insertRecurring(1, accountId, {
      label: day5,
      amountCents: BigInt(-50_000),
      dayOfMonth: 5,
    });
    await insertRecurring(1, accountId, {
      label: day10cheap,
      amountCents: BigInt(-10_000),
      dayOfMonth: 10,
    });
    await insertRecurring(1, accountId, {
      label: day10expensive,
      amountCents: BigInt(-500_000),
      dayOfMonth: 10,
    });

    const { rows } = await getSubscriptions(1, "native", 4200);
    const testRows = rows.filter((r) =>
      [day5, day10cheap, day10expensive, day20].includes(r.label),
    );
    // Calendar order: day 5, then day 10 (expensive first as tiebreaker), then day 20.
    expect(testRows.map((r) => r.label)).toEqual([day5, day10expensive, day10cheap, day20]);
  });

  it("nextOccurrence respects skippedMonths from the DB row", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}skipped`;
    const today = new Date();
    const todayDay = today.getUTCDate();
    // Use dayOfMonth = 1 so it's always "this month or next".
    const dom = 1;
    // Skip the first candidate month to force the helper to advance.
    const candidateMonth =
      todayDay <= dom
        ? `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`
        : (() => {
            const m = today.getUTCMonth() + 2; // 1-based next month
            const y = today.getUTCFullYear() + (m > 12 ? 1 : 0);
            return `${y}-${String(m > 12 ? m - 12 : m).padStart(2, "0")}`;
          })();

    await insertRecurring(1, accountId, {
      label,
      dayOfMonth: dom,
      skippedMonths: [candidateMonth],
    });

    const { rows } = await getSubscriptions(1, "native", 4200);
    const found = rows.find((r) => r.label === label);
    expect(found).toBeDefined();
    // The nextOccurrence must NOT be in the skipped month.
    expect(found!.nextOccurrence.startsWith(candidateMonth)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // C2: displayCurrencyMode totals
  // -------------------------------------------------------------------------

  it('totals produce ONE COP bucket in "all-cop" mode over a mix of COP + USD rows', async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    // COP subscription: -150 000 COP monthly
    const copLabel = `${TEST_LABEL_PREFIX}cop_total`;
    const copMonthly = BigInt(-150_000);
    await insertRecurring(1, accountId, {
      label: copLabel,
      amountCents: copMonthly,
      currency: "COP",
    });

    // We need a USD account to insert a USD subscription.
    const [usdAccRow] = await db.execute<{ id: number }>(sql`
      INSERT INTO accounts (user_id, name, institution, type, currency)
      VALUES (1, '__test_usd_account__', 'Test Bank', 'savings', 'USD')
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    // Fallback: if ON CONFLICT DO NOTHING returned nothing, look it up.
    const usdAccountId: number =
      usdAccRow?.id ??
      (
        await db.execute<{ id: number }>(
          sql`SELECT id FROM accounts WHERE user_id = 1 AND name = '__test_usd_account__' LIMIT 1`,
        )
      )[0]!.id;

    // USD subscription: -10 USD monthly (i.e. -1000 cents)
    const usdLabel = `${TEST_LABEL_PREFIX}usd_total`;
    const usdMonthly = BigInt(-1_000); // -10.00 USD in cents
    const copPerUsd = 4_200;
    await insertRecurring(1, usdAccountId, {
      label: usdLabel,
      amountCents: usdMonthly,
      currency: "USD",
    });

    const { monthlyTotals } = await getSubscriptions(1, "all-cop", copPerUsd);

    // In all-cop mode there must be exactly ONE bucket (COP).
    expect(monthlyTotals).toHaveLength(1);
    expect(monthlyTotals[0]!.currency).toBe("COP");

    // Find our two test rows in the result to verify the total.
    // COP row passes through; USD row is converted: -1000 cents × 4200 = -4_200_000 COP cents.
    const usdInCopCents = (usdMonthly * BigInt(copPerUsd * 1_000_000)) / BigInt(1_000_000);

    // The bucket may include other seed rows. To isolate our two rows we run
    // a scoped assertion: extract only our test labels' converted amounts.
    const allRows = (await getSubscriptions(1, "all-cop", copPerUsd)).rows;
    const copRow = allRows.find((r) => r.label === copLabel);
    const usdRow = allRows.find((r) => r.label === usdLabel);
    expect(copRow).toBeDefined();
    expect(usdRow).toBeDefined();

    // copRow displayAmount = native (COP stays COP)
    expect(copRow!.displayAmount.currency).toBe("COP");
    expect(copRow!.displayAmount.cents).toBe(copMonthly);

    // usdRow displayAmount must be in COP with the applied TRM.
    expect(usdRow!.displayAmount.currency).toBe("COP");
    expect(usdRow!.displayAmount.converted).toBe(true);
    expect(usdRow!.displayAmount.cents).toBe(usdInCopCents);

    // monthlyTotals single bucket cents must include both converted amounts.
    // (There may be other seed rows; we only verify our two are summed correctly
    // by checking the bucket cents == sum of all rows' displayAmount.cents.)
    const totalFromRows = allRows.reduce((acc, r) => acc + r.displayAmount.cents, BigInt(0));
    expect(monthlyTotals[0]!.cents).toBe(totalFromRows);

    // Cleanup the USD test account after assertions.
    await db.execute(sql`DELETE FROM accounts WHERE name = '__test_usd_account__' AND user_id = 1`);
  });

  it('totals produce TWO buckets in "native" mode over a mix of COP + USD rows', async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    // COP subscription
    const copLabel = `${TEST_LABEL_PREFIX}cop_native`;
    await insertRecurring(1, accountId, {
      label: copLabel,
      amountCents: BigInt(-200_000),
      currency: "COP",
    });

    // USD account + subscription
    const [usdAccRow] = await db.execute<{ id: number }>(sql`
      INSERT INTO accounts (user_id, name, institution, type, currency)
      VALUES (1, '__test_usd_account2__', 'Test Bank', 'savings', 'USD')
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const usdAccountId: number =
      usdAccRow?.id ??
      (
        await db.execute<{ id: number }>(
          sql`SELECT id FROM accounts WHERE user_id = 1 AND name = '__test_usd_account2__' LIMIT 1`,
        )
      )[0]!.id;

    const usdLabel = `${TEST_LABEL_PREFIX}usd_native`;
    await insertRecurring(1, usdAccountId, {
      label: usdLabel,
      amountCents: BigInt(-500),
      currency: "USD",
    });

    const { monthlyTotals } = await getSubscriptions(1, "native", 4200);

    // In native mode, COP and USD must be in separate buckets.
    const currencies = monthlyTotals.map((b) => b.currency);
    expect(currencies).toContain("COP");
    expect(currencies).toContain("USD");

    // Cleanup the USD test account.
    await db.execute(
      sql`DELETE FROM accounts WHERE name = '__test_usd_account2__' AND user_id = 1`,
    );
  });

  // -------------------------------------------------------------------------
  // #701: price-hike enrichment
  // -------------------------------------------------------------------------

  /**
   * Insert synthetic observations for a recurring directly via raw SQL.
   * We use raw SQL to avoid importing the full observation-recorder (which
   * requires a real linked tx). We generate synthetic tx_id values by
   * inserting placeholder transactions first.
   *
   * @param userId        Owner of the observations.
   * @param recurringId   The recurring to attach observations to.
   * @param accountId     Account id (needed for the tx FK).
   * @param amounts       Array of amountCents values, OLDEST FIRST.
   *                      Each gets a distinct observed_at offset.
   */
  async function insertObservations(
    userId: number,
    recurringId: number,
    accountId: number,
    amounts: bigint[],
  ): Promise<void> {
    const baseTs = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < amounts.length; i++) {
      const observedAt = new Date(baseTs.getTime() + i * 30 * 24 * 60 * 60 * 1000);
      const observedAtStr = observedAt.toISOString();
      const yearMonth = `${observedAt.getUTCFullYear()}-${String(observedAt.getUTCMonth() + 1).padStart(2, "0")}`;
      const amount = amounts[i]!;

      // Insert a minimal transaction to satisfy the FK.
      const [txRow] = await db.execute<{ id: number }>(sql`
        INSERT INTO transactions (user_id, account_id, description_raw, amount_cents, currency, occurred_at, source)
        VALUES (
          ${userId}, ${accountId},
          ${`__test_obs_tx_${recurringId}_${i}`},
          ${amount.toString()}::bigint, 'COP',
          ${observedAtStr}::timestamptz,
          'manual'::tx_source
        )
        RETURNING id
      `);
      const txId = txRow!.id;

      await db.execute(sql`
        INSERT INTO recurring_link_observations
          (user_id, recurring_id, tx_id, year_month, real_amount_cents, real_currency, account_id, manual, observed_at)
        VALUES
          (${userId}, ${recurringId}, ${txId}, ${yearMonth}, ${amount.toString()}::bigint, 'COP', ${accountId}, false, ${observedAtStr}::timestamptz)
        ON CONFLICT DO NOTHING
      `);
    }
  }

  async function cleanupObsAndTxs(): Promise<void> {
    await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__test_obs_tx_%'`);
  }

  it("fixed subscription with ≥4 qualifying observations gets priceHike populated", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}hike_fixed`;
    const { id: recurringId } = await insertRecurring(1, accountId, {
      label,
      amountType: "fixed",
      amountCents: BigInt(-2_800_000),
    });

    // Insert 4 observations oldest→newest: 3 at -2_200_000, then 1 at -2_800_000.
    await insertObservations(1, recurringId, accountId, [
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_800_000),
    ]);

    const { rows } = await getSubscriptions(1, "native", 4200);
    const found = rows.find((r) => r.label === label);
    expect(found).toBeDefined();
    expect(found!.priceHike).not.toBeNull();
    expect(found!.priceHike!.oldAmountCents).toBe(BigInt(-2_200_000));
    expect(found!.priceHike!.newAmountCents).toBe(BigInt(-2_800_000));
    expect(found!.priceHike!.deltaPct).toBeGreaterThan(15);

    await cleanupObsAndTxs();
  });

  it("variable subscription never gets priceHike even with hike-shaped observations", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}hike_variable`;
    const { id: recurringId } = await insertRecurring(1, accountId, {
      label,
      amountType: "variable",
      amountCents: BigInt(-2_800_000),
    });

    // Insert 4 hike-shaped observations — these should be ignored for variable rows.
    await insertObservations(1, recurringId, accountId, [
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_800_000),
    ]);

    const { rows } = await getSubscriptions(1, "native", 4200);
    const found = rows.find((r) => r.label === label);
    expect(found).toBeDefined();
    expect(found!.priceHike).toBeNull();

    await cleanupObsAndTxs();
  });

  it("row without enough history (<4 obs) gets no priceHike", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label = `${TEST_LABEL_PREFIX}hike_insufficient`;
    const { id: recurringId } = await insertRecurring(1, accountId, {
      label,
      amountType: "fixed",
      amountCents: BigInt(-2_800_000),
    });

    // Insert only 3 observations (need 4 minimum).
    await insertObservations(1, recurringId, accountId, [
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_800_000),
    ]);

    const { rows } = await getSubscriptions(1, "native", 4200);
    const found = rows.find((r) => r.label === label);
    expect(found).toBeDefined();
    expect(found!.priceHike).toBeNull();

    await cleanupObsAndTxs();
  });

  it("tenant isolation: user 1 hike calc does not see user 2 observations", async () => {
    // Setup user 2.
    const uniqueEmail = `${TEST_LABEL_PREFIX}hike_user2@test.local`;
    const [user2Row] = await db.execute<{ id: number }>(sql`
      INSERT INTO users (email, name)
      VALUES (${uniqueEmail}, 'Hike Tenant Test User 2')
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const user2Id = user2Row!.id;

    const [acc2Row] = await db.execute<{ id: number }>(sql`
      INSERT INTO accounts (user_id, name, institution, type, currency)
      VALUES (${user2Id}, '__test_hike_acc2__', 'Test Bank', 'savings', 'COP')
      RETURNING id
    `);
    const accountId2 = acc2Row!.id;

    await db.execute(sql`
      INSERT INTO categories (user_id, slug, name, parent_slug, sort_order)
      VALUES (${user2Id}, 'suscripciones', 'Suscripciones', NULL, 10)
      ON CONFLICT (user_id, slug) DO NOTHING
    `);

    // User 1 row: only 2 observations (not enough for hike alone).
    const accountId1 = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const label1 = `${TEST_LABEL_PREFIX}hike_tenant1`;
    const { id: recurringId1 } = await insertRecurring(1, accountId1, {
      label: label1,
      amountType: "fixed",
      amountCents: BigInt(-2_800_000),
    });
    await insertObservations(1, recurringId1, accountId1, [BigInt(-2_200_000), BigInt(-2_800_000)]);

    // User 2 has 4 qualifying observations for a DIFFERENT recurring.
    // These must NOT bleed into user 1's calculation.
    const label2 = `${TEST_LABEL_PREFIX}hike_tenant2`;
    const { id: recurringId2 } = await insertRecurring(user2Id, accountId2, {
      label: label2,
      amountType: "fixed",
      amountCents: BigInt(-2_800_000),
    });
    await insertObservations(user2Id, recurringId2, accountId2, [
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_800_000),
    ]);

    // User 1 should see NO hike (only 2 obs, < 4 required).
    const { rows } = await getSubscriptions(1, "native", 4200);
    const found1 = rows.find((r) => r.label === label1);
    expect(found1).toBeDefined();
    expect(found1!.priceHike).toBeNull();

    // User 1 results must NOT include user 2's recurring.
    expect(rows.find((r) => r.label === label2)).toBeUndefined();

    await cleanupObsAndTxs();
    await db.execute(sql`DELETE FROM accounts WHERE name = '__test_hike_acc2__'`);
  });
});
