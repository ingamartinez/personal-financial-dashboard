import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { recurringTransactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const { upsertRecurring, archiveRecurring, promoteUpcoming } = await import("./actions");

const TEST_USER_ID = 1;
const TEST_LABEL = "__test_recurring_archive";

async function cleanup() {
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label = ${TEST_LABEL}`);
}

async function getAccountId(): Promise<number> {
  const [acc] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} LIMIT 1
  `);
  if (!acc) throw new Error("No seed account for user 1");
  return acc.id;
}

describe("recurring actions: archive flow", () => {
  afterEach(cleanup);

  it("upsertRecurring then archiveRecurring hides the row from default reads but keeps it on disk", async () => {
    const accountId = await getAccountId();
    await upsertRecurring({
      accountId,
      label: TEST_LABEL,
      amount: 1_500_000,
      direction: "expense",
      categorySlug: null,
      dayOfMonth: 5,
      active: true,
      notes: null,
    });

    const [created] = await db
      .select({ id: recurringTransactions.id, deletedAt: recurringTransactions.deletedAt })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, TEST_USER_ID),
          eq(recurringTransactions.label, TEST_LABEL),
        ),
      );
    expect(created).toBeDefined();
    expect(created.deletedAt).toBeNull();

    await archiveRecurring(created.id);

    const live = await db
      .select({ id: recurringTransactions.id })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, TEST_USER_ID),
          eq(recurringTransactions.label, TEST_LABEL),
          notDeleted(recurringTransactions.deletedAt),
        ),
      );
    expect(live).toHaveLength(0);

    const archived = await db
      .select({ id: recurringTransactions.id, deletedAt: recurringTransactions.deletedAt })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, TEST_USER_ID),
          eq(recurringTransactions.label, TEST_LABEL),
          isNotNull(recurringTransactions.deletedAt),
        ),
      );
    expect(archived).toHaveLength(1);
  });

  it("promoteUpcoming on an archived recurring throws 'Recurring not found'", async () => {
    const accountId = await getAccountId();
    await upsertRecurring({
      accountId,
      label: TEST_LABEL,
      amount: 1_500_000,
      direction: "expense",
      categorySlug: null,
      dayOfMonth: 5,
      active: true,
      notes: null,
    });
    const [created] = await db
      .select({ id: recurringTransactions.id })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, TEST_USER_ID),
          eq(recurringTransactions.label, TEST_LABEL),
        ),
      );

    await archiveRecurring(created.id);

    await expect(
      promoteUpcoming({
        recurringId: created.id,
        yearMonth: "2099-01",
        occurredOn: "2099-01-05",
      }),
    ).rejects.toThrow("Recurring not found");
  });
});
