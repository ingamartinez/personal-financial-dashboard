import { afterEach, describe, expect, it, vi } from "vitest";
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
    // user 2 must exist in the test DB (seed creates both users).
    const [user2] = await db.execute<{ id: number }>(
      sql`SELECT id FROM users WHERE id = 2 LIMIT 1`,
    );
    if (!user2) return; // Skip if test DB only has one user.

    const accountId2 = await getAccountId(2);

    // Ensure suscripciones category for user 2 as well.
    await db.execute(sql`
      INSERT INTO categories (user_id, slug, name, parent_slug, sort_order)
      VALUES (2, 'suscripciones', 'Suscripciones', 'gastos-fijos', 10)
      ON CONFLICT (user_id, slug) DO NOTHING
    `);

    const label2 = `${TEST_LABEL_PREFIX}user2`;
    await insertRecurring(2, accountId2, { label: label2 });

    const { rows } = await getSubscriptions(1, "native", 4200);
    expect(rows.find((r) => r.label === label2)).toBeUndefined();
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

  it("rows are sorted by absolute display amount descending", async () => {
    const accountId = await getAccountId(1);
    await ensureSuscripcionesCategory(1);

    const cheap = `${TEST_LABEL_PREFIX}cheap`;
    const expensive = `${TEST_LABEL_PREFIX}expensive`;
    await insertRecurring(1, accountId, { label: cheap, amountCents: BigInt(-10_000) });
    await insertRecurring(1, accountId, { label: expensive, amountCents: BigInt(-500_000) });

    const { rows } = await getSubscriptions(1, "native", 4200);
    // Filter to only our test rows to avoid seed data interference.
    const testRows = rows.filter((r) => r.label === cheap || r.label === expensive);
    expect(testRows[0]!.label).toBe(expensive);
    expect(testRows[1]!.label).toBe(cheap);
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
});
