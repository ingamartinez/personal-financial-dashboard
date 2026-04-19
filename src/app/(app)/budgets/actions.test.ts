import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { budgets } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const { upsertBudget, archiveBudget } = await import("./actions");

const TEST_USER_ID = 1;
// Use a far-past month so we never collide with real dev data.
const TEST_YM = "2099-01";

async function cleanup() {
  await db.execute(sql`DELETE FROM budgets WHERE period_start = '2099-01-01'`);
}

describe("budgets actions: archive flow", () => {
  afterEach(cleanup);

  it("upsertBudget then archiveBudget hides the row from default reads but keeps it on disk", async () => {
    await upsertBudget({
      categorySlug: "alimentacion",
      amount: 500_000,
      currency: "COP",
      ym: TEST_YM,
    });

    const [created] = await db
      .select({ id: budgets.id, deletedAt: budgets.deletedAt })
      .from(budgets)
      .where(and(eq(budgets.userId, TEST_USER_ID), eq(budgets.periodStart, "2099-01-01")));
    expect(created).toBeDefined();
    expect(created.deletedAt).toBeNull();

    await archiveBudget(created.id);

    // Default read (with notDeleted) hides it
    const live = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(
        and(
          eq(budgets.userId, TEST_USER_ID),
          eq(budgets.periodStart, "2099-01-01"),
          notDeleted(budgets.deletedAt),
        ),
      );
    expect(live).toHaveLength(0);

    // Row still on disk with deleted_at populated (audit/restore path)
    const archived = await db
      .select({ id: budgets.id, deletedAt: budgets.deletedAt })
      .from(budgets)
      .where(
        and(
          eq(budgets.userId, TEST_USER_ID),
          eq(budgets.periodStart, "2099-01-01"),
          isNotNull(budgets.deletedAt),
        ),
      );
    expect(archived).toHaveLength(1);
    expect(archived[0].deletedAt).toBeInstanceOf(Date);
  });

  it("archiving the same budget twice is idempotent (second call no-ops)", async () => {
    await upsertBudget({
      categorySlug: "alimentacion",
      amount: 500_000,
      currency: "COP",
      ym: TEST_YM,
    });
    const [row] = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.userId, TEST_USER_ID), eq(budgets.periodStart, "2099-01-01")));

    await archiveBudget(row.id);
    const [first] = await db
      .select({ deletedAt: budgets.deletedAt })
      .from(budgets)
      .where(eq(budgets.id, row.id));

    await archiveBudget(row.id);
    const [second] = await db
      .select({ deletedAt: budgets.deletedAt })
      .from(budgets)
      .where(eq(budgets.id, row.id));

    expect(second.deletedAt?.getTime()).toBe(first.deletedAt?.getTime());
  });

  it("upsertBudget after archive can re-create a budget for the same category+month", async () => {
    await upsertBudget({
      categorySlug: "alimentacion",
      amount: 500_000,
      currency: "COP",
      ym: TEST_YM,
    });
    const [original] = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.userId, TEST_USER_ID), eq(budgets.periodStart, "2099-01-01")));
    await archiveBudget(original.id);

    // Should NOT throw "Budget for this category and month already exists"
    await expect(
      upsertBudget({
        categorySlug: "alimentacion",
        amount: 750_000,
        currency: "COP",
        ym: TEST_YM,
      }),
    ).resolves.toBeUndefined();

    const live = await db
      .select({ id: budgets.id, amountCents: budgets.amountCents })
      .from(budgets)
      .where(
        and(
          eq(budgets.userId, TEST_USER_ID),
          eq(budgets.periodStart, "2099-01-01"),
          notDeleted(budgets.deletedAt),
        ),
      );
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(original.id);
    expect(live[0].amountCents).toBe(BigInt(75_000_000));
  });
});
