import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { recurringGaps, recurringTransactions, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const {
  upsertRecurring,
  archiveRecurring,
  promoteUpcoming,
  markOccurrencePaidExternal,
  unmarkOccurrencePaidExternal,
} = await import("./actions");

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

// ---------------------------------------------------------------------------
// #1034 — mark an occurrence as paid from an account findash does not track.
// The slot is (recurring_id, year_month); resolving it must NOT invent a
// transaction, so resolution_tx_id stays NULL (S2/S6) and both directions are
// idempotent.
// ---------------------------------------------------------------------------

describe("mark/unmark occurrence as paid from an untracked account (#1034)", () => {
  const PAID_LABEL = "__test_paid_external";
  const OTHER_EMAIL = "__test_paid_external_user2@test.local";

  async function cleanupPaid() {
    await db.execute(
      sql`DELETE FROM recurring_gaps WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label = ${PAID_LABEL})`,
    );
    await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE ${PAID_LABEL + "%"}`);
    await db.execute(sql`DELETE FROM recurring_transactions WHERE label = ${PAID_LABEL}`);
    await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_EMAIL}`);
  }

  afterEach(cleanupPaid);

  async function seedRecurring(userId = TEST_USER_ID, accountId?: number) {
    const account = accountId ?? (await getAccountId());
    const [row] = await db
      .insert(recurringTransactions)
      .values({
        userId,
        accountId: account,
        label: PAID_LABEL,
        amountCents: BigInt(-1_500_000),
        currency: "COP",
        dayOfMonth: 15,
        active: true,
      })
      .returning({ id: recurringTransactions.id });
    return row!.id;
  }

  async function readSlot(recurringId: number, ym: string) {
    const rows = await db
      .select({
        resolution: recurringGaps.resolution,
        resolutionTxId: recurringGaps.resolutionTxId,
        resolvedAt: recurringGaps.resolvedAt,
      })
      .from(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recurringId), eq(recurringGaps.yearMonth, ym)));
    return rows;
  }

  it("creates the slot with resolution 'paid-external', resolvedAt set and NO resolutionTxId", async () => {
    const recurringId = await seedRecurring();

    await markOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });

    const rows = await readSlot(recurringId, "2026-11");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolution).toBe("paid-external");
    expect(rows[0]!.resolutionTxId).toBeNull();
    expect(rows[0]!.resolvedAt).not.toBeNull();
  });

  it("closes an already-open gap slot instead of adding a second row", async () => {
    const recurringId = await seedRecurring();
    await db
      .insert(recurringGaps)
      .values({ userId: TEST_USER_ID, recurringId, yearMonth: "2026-11" });

    await markOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });

    const rows = await readSlot(recurringId, "2026-11");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolution).toBe("paid-external");
    expect(rows[0]!.resolvedAt).not.toBeNull();
  });

  it("is idempotent — marking twice leaves one slot in the same state", async () => {
    const recurringId = await seedRecurring();

    await markOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });
    const first = await readSlot(recurringId, "2026-11");
    await markOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });
    const second = await readSlot(recurringId, "2026-11");

    expect(second).toHaveLength(1);
    expect(second[0]!.resolution).toBe("paid-external");
    expect(second[0]!.resolvedAt?.getTime()).toBe(first[0]!.resolvedAt?.getTime());
  });

  it("unmarking reopens the slot (resolution/resolvedAt NULL) and is idempotent", async () => {
    const recurringId = await seedRecurring();
    await markOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });

    await unmarkOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });
    const reopened = await readSlot(recurringId, "2026-11");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.resolution).toBeNull();
    expect(reopened[0]!.resolutionTxId).toBeNull();
    expect(reopened[0]!.resolvedAt).toBeNull();

    // Second unmark is a no-op, not an error.
    await unmarkOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });
    const again = await readSlot(recurringId, "2026-11");
    expect(again).toHaveLength(1);
    expect(again[0]!.resolution).toBeNull();
  });

  it("unmarking leaves a slot with another resolution untouched", async () => {
    const recurringId = await seedRecurring();
    await db.insert(recurringGaps).values({
      userId: TEST_USER_ID,
      recurringId,
      yearMonth: "2026-11",
      resolution: "skipped",
    });

    await unmarkOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" });

    const rows = await readSlot(recurringId, "2026-11");
    expect(rows[0]!.resolution).toBe("skipped");
  });

  it("refuses to mark a month a transaction already covers, leaving the slot untouched", async () => {
    const accountId = await getAccountId();
    const recurringId = await seedRecurring(TEST_USER_ID, accountId);
    const [tx] = await db
      .insert(transactions)
      .values({
        userId: TEST_USER_ID,
        accountId,
        occurredAt: new Date("2026-11-15T12:00:00Z"),
        amountCents: BigInt(-1_500_000),
        currency: "COP",
        descriptionRaw: `${PAID_LABEL}_tx`,
        source: "manual",
        recurringId,
        recurringYearMonth: "2026-11",
      })
      .returning({ id: transactions.id });

    await expect(markOccurrencePaidExternal({ recurringId, yearMonth: "2026-11" })).rejects.toThrow(
      `Already covered this month by tx #${tx!.id}`,
    );

    expect(await readSlot(recurringId, "2026-11")).toHaveLength(0);
  });

  it("refuses another user's recurring — no slot is written", async () => {
    const [user2] = await db.execute<{ id: number }>(sql`
      INSERT INTO users (email, name)
      VALUES (${OTHER_EMAIL}, 'Paid External Tenant 2')
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const [acc2] = await db.execute<{ id: number }>(sql`
      INSERT INTO accounts (user_id, name, institution, type, currency)
      VALUES (${user2!.id}, '__test_paid_external_acc2__', 'Test Bank', 'savings', 'COP')
      RETURNING id
    `);
    const foreignRecurringId = await seedRecurring(user2!.id, acc2!.id);

    await expect(
      markOccurrencePaidExternal({ recurringId: foreignRecurringId, yearMonth: "2026-11" }),
    ).rejects.toThrow("Recurring not found");

    expect(await readSlot(foreignRecurringId, "2026-11")).toHaveLength(0);
    await db.execute(sql`DELETE FROM accounts WHERE name = '__test_paid_external_acc2__'`);
  });
});
