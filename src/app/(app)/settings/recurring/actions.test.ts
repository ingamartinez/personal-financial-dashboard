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

describe("recurring actions: currency independence (#803)", () => {
  afterEach(cleanup);

  it("creating a recurring on a USD account with currency COP persists COP, not the account's currency", async () => {
    const [usdAccount] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND currency = 'USD' LIMIT 1
    `);
    if (!usdAccount) throw new Error("No seeded USD account for user 1");

    await upsertRecurring({
      accountId: usdAccount.id,
      label: TEST_LABEL,
      amount: 2_300_000,
      direction: "expense",
      currency: "COP",
      categorySlug: null,
      dayOfMonth: 5,
      active: true,
      notes: null,
    });

    const [created] = await db
      .select({
        currency: recurringTransactions.currency,
        amountCents: recurringTransactions.amountCents,
      })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, TEST_USER_ID),
          eq(recurringTransactions.label, TEST_LABEL),
        ),
      );

    expect(created.currency).toBe("COP");
    expect(created.amountCents).toBe(BigInt(-230_000_000));
  });

  it("omitting currency falls back to the linked account's currency (pre-#803 callers)", async () => {
    const [usdAccount] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND currency = 'USD' LIMIT 1
    `);
    if (!usdAccount) throw new Error("No seeded USD account for user 1");

    await upsertRecurring({
      accountId: usdAccount.id,
      label: TEST_LABEL,
      amount: 10,
      direction: "expense",
      categorySlug: null,
      dayOfMonth: 5,
      active: true,
      notes: null,
    });

    const [created] = await db
      .select({ currency: recurringTransactions.currency })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, TEST_USER_ID),
          eq(recurringTransactions.label, TEST_LABEL),
        ),
      );

    expect(created.currency).toBe("USD");
  });

  it("updating an existing recurring changes currency and amount together in one save", async () => {
    const accountId = await getAccountId();
    await upsertRecurring({
      accountId,
      label: TEST_LABEL,
      amount: 100,
      direction: "expense",
      currency: "USD",
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

    await upsertRecurring({
      id: created.id,
      accountId,
      label: TEST_LABEL,
      amount: 2_300_000,
      direction: "expense",
      currency: "COP",
      categorySlug: null,
      dayOfMonth: 5,
      active: true,
      notes: null,
    });

    const [updated] = await db
      .select({
        currency: recurringTransactions.currency,
        amountCents: recurringTransactions.amountCents,
      })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, created.id));

    expect(updated.currency).toBe("COP");
    expect(updated.amountCents).toBe(BigInt(-230_000_000));
  });
});

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
