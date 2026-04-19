import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, transactions, users } from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const { upsertAccount, archiveAccount, toggleAccountActive, adjustAccountBalance } =
  await import("./actions");

const TEST_USER_ID = 1;
const MARKER = "__test_accounts_ui";

async function cleanup() {
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${MARKER + "%"}`);
}

describe("accounts actions: single-currency", () => {
  afterEach(cleanup);

  it("creates a savings account then archives it (soft-delete)", async () => {
    await upsertAccount({
      name: `${MARKER}-savings`,
      institution: "Bancolombia",
      type: "savings",
      active: true,
      primary: { currency: "COP", balance: 1_200_000 },
    });

    const [row] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-savings`)));
    expect(row).toBeDefined();
    expect(row.type).toBe("savings");
    expect(row.currency).toBe("COP");
    expect(row.balanceCents).toBe(BigInt(120_000_000));
    expect(row.physicalCardId).toBeNull();
    expect(row.deletedAt).toBeNull();

    await archiveAccount(row.id);

    const live = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, TEST_USER_ID),
          eq(accounts.name, `${MARKER}-savings`),
          notDeleted(accounts.deletedAt),
        ),
      );
    expect(live).toHaveLength(0);

    const archived = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, TEST_USER_ID),
          eq(accounts.name, `${MARKER}-savings`),
          isNotNull(accounts.deletedAt),
        ),
      );
    expect(archived).toHaveLength(1);
  });

  it("updates an existing account via id", async () => {
    await upsertAccount({
      name: `${MARKER}-edit`,
      institution: "Bancolombia",
      type: "savings",
      primary: { currency: "COP", balance: 500_000 },
    });
    const [before] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-edit`)));

    await upsertAccount({
      id: before.id,
      name: `${MARKER}-edit`,
      institution: "Bancolombia",
      type: "savings",
      primary: { currency: "COP", balance: 750_000 },
    });

    const [after] = await db.select().from(accounts).where(eq(accounts.id, before.id));
    expect(after.balanceCents).toBe(BigInt(75_000_000));
  });

  it("rejects secondary currency on non-credit_card types", async () => {
    await expect(
      upsertAccount({
        name: `${MARKER}-bad`,
        institution: "Bancolombia",
        type: "savings",
        primary: { currency: "COP", balance: 100_000 },
        secondary: { currency: "USD", balance: 50 },
      }),
    ).rejects.toThrow();
  });
});

describe("accounts actions: multi-currency credit card", () => {
  afterEach(cleanup);

  it("creates two linked rows sharing physical_card_id", async () => {
    await upsertAccount({
      name: `${MARKER}-amex`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: {
        currency: "COP",
        balance: 0,
        metadata: { network: "amex", last4s: ["1234"], creditLimitCents: 500_000_000 },
      },
      secondary: {
        currency: "USD",
        balance: 0,
        metadata: { network: "amex", last4s: ["1234"], creditLimitCents: 200_000 },
      },
    });

    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-amex`)));
    expect(rows).toHaveLength(2);
    expect(rows[0].physicalCardId).not.toBeNull();
    expect(rows[0].physicalCardId).toBe(rows[1].physicalCardId);
    const currencies = rows.map((r) => r.currency).sort();
    expect(currencies).toEqual(["COP", "USD"]);
  });

  it("archives each linked row independently (no cascade)", async () => {
    await upsertAccount({
      name: `${MARKER}-intl`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: { currency: "COP", balance: 0 },
      secondary: { currency: "USD", balance: 0 },
    });
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-intl`)));
    expect(rows).toHaveLength(2);

    const copRow = rows.find((r) => r.currency === "COP")!;
    await archiveAccount(copRow.id);

    const live = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, TEST_USER_ID),
          eq(accounts.name, `${MARKER}-intl`),
          notDeleted(accounts.deletedAt),
        ),
      );
    expect(live).toHaveLength(1);
    expect(live[0].currency).toBe("USD");
  });

  it("rejects secondary on edit (multi-currency only at create)", async () => {
    await upsertAccount({
      name: `${MARKER}-single-cc`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: { currency: "COP", balance: 0 },
    });
    const [row] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-single-cc`)));

    await expect(
      upsertAccount({
        id: row.id,
        name: `${MARKER}-single-cc`,
        institution: "Bancolombia",
        type: "credit_card",
        primary: { currency: "COP", balance: 0 },
        secondary: { currency: "USD", balance: 0 },
      }),
    ).rejects.toThrow();
  });
});

describe("accounts actions: auth scoping", () => {
  const OTHER_USER_EMAIL = `${MARKER}-other@test.local`;
  let otherUserId = 0;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: OTHER_USER_EMAIL, name: "Other User" })
      .returning({ id: users.id });
    otherUserId = u.id;
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_USER_EMAIL}`);
  });
  afterEach(cleanup);

  it("archive cannot target another user's account", async () => {
    await db.insert(accounts).values({
      userId: otherUserId,
      name: `${MARKER}-other-user`,
      institution: "Other",
      type: "savings",
      currency: "COP",
      balanceCents: BigInt(0),
    });
    const [victim] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, otherUserId), eq(accounts.name, `${MARKER}-other-user`)));

    await archiveAccount(victim.id);

    const [stillLive] = await db.select().from(accounts).where(eq(accounts.id, victim.id));
    expect(stillLive.deletedAt).toBeNull();
  });

  it("toggleAccountActive flips the flag", async () => {
    await upsertAccount({
      name: `${MARKER}-toggle`,
      institution: "Bancolombia",
      type: "savings",
      primary: { currency: "COP", balance: 0 },
    });
    const [row] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-toggle`)));

    await toggleAccountActive(row.id, false);
    const [after] = await db.select().from(accounts).where(eq(accounts.id, row.id));
    expect(after.active).toBe(false);
  });
});

describe("adjustAccountBalance", () => {
  const ADJ_MARKER = "__test_adjust_acct";

  async function adjustCleanup() {
    await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE 'Ajuste de saldo%'`);
    await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${ADJ_MARKER + "%"}`);
  }

  afterEach(adjustCleanup);

  async function seedAccount(balance: number): Promise<number> {
    await upsertAccount({
      name: `${ADJ_MARKER}-main`,
      institution: "Bancolombia",
      type: "savings",
      primary: { currency: "COP", balance },
    });
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${ADJ_MARKER}-main`)));
    return row.id;
  }

  it("positive diff: creates adjustment tx and bumps account balance up", async () => {
    const accountId = await seedAccount(100_000); // balance 10_000_000 cents
    const result = await adjustAccountBalance({
      accountId,
      declaredBalanceCents: 12_000_000,
      reason: "Transferencia que no llegó por SMS",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.diffCents).toBe("2000000");
      const [tx] = await db.select().from(transactions).where(eq(transactions.id, result.txId));
      expect(tx.isAdjustment).toBe(true);
      expect(tx.amountCents).toBe(BigInt(2_000_000));
      expect(tx.categorySlug).toBe("adjustments");
      expect(tx.source).toBe("balance_adjustment");
      expect(tx.channel).toBe("manual");
      expect(tx.classificationMethod).toBe("manual");
    }

    const [after] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(after.balanceCents).toBe(BigInt(12_000_000));
  });

  it("negative diff: creates adjustment tx for the shortfall", async () => {
    const accountId = await seedAccount(100_000);
    const result = await adjustAccountBalance({ accountId, declaredBalanceCents: 8_000_000 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.diffCents).toBe("-2000000");
    }
  });

  it("no-op when declared matches current", async () => {
    const accountId = await seedAccount(100_000);
    const result = await adjustAccountBalance({ accountId, declaredBalanceCents: 10_000_000 });
    expect(result.status).toBe("noop");

    const txs = await db.select().from(transactions).where(eq(transactions.accountId, accountId));
    expect(txs).toHaveLength(0);
  });

  it("auto-heals: creates 'adjustments' category if user archived it", async () => {
    const accountId = await seedAccount(100_000);
    await db
      .update(categories)
      .set({ deletedAt: new Date() })
      .where(and(eq(categories.userId, TEST_USER_ID), eq(categories.slug, "adjustments")));

    const result = await adjustAccountBalance({ accountId, declaredBalanceCents: 11_000_000 });
    expect(result.status).toBe("ok");

    const [cat] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.userId, TEST_USER_ID), eq(categories.slug, "adjustments")));
    expect(cat.deletedAt).toBeNull();
  });

  it("refuses to adjust another user's account", async () => {
    // Create a second user + account
    const [otherUser] = await db
      .insert(users)
      .values({ email: `${ADJ_MARKER}-other@test.local`, name: "Other" })
      .returning({ id: users.id });
    const [otherAccount] = await db
      .insert(accounts)
      .values({
        userId: otherUser.id,
        name: `${ADJ_MARKER}-other-account`,
        institution: "Bancolombia",
        type: "savings",
        currency: "COP",
        balanceCents: BigInt(100_000_00),
      })
      .returning({ id: accounts.id });

    const result = await adjustAccountBalance({
      accountId: otherAccount.id,
      declaredBalanceCents: 200_000_00,
    });
    expect(result.status).toBe("error");

    await db.execute(sql`DELETE FROM accounts WHERE id = ${otherAccount.id}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${otherUser.id}`);
  });

  it("notAdjustment helper filters adjustment rows from spend queries", async () => {
    const accountId = await seedAccount(100_000);
    await adjustAccountBalance({ accountId, declaredBalanceCents: 11_500_000 });

    // All user txns
    const all = await db.select().from(transactions).where(eq(transactions.userId, TEST_USER_ID));
    const hasAdjustment = all.some((t) => t.isAdjustment);
    expect(hasAdjustment).toBe(true);

    // Spend query shape: exclude adjustments
    const spendOnly = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, TEST_USER_ID), notAdjustment(transactions.isAdjustment)));
    const hasAdjustmentInSpend = spendOnly.some((t) => t.isAdjustment);
    expect(hasAdjustmentInSpend).toBe(false);
  });
});
