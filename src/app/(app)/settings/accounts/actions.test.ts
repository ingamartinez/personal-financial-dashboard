import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  physicalCards,
  transactions,
  users,
  type AccountMetadata,
} from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const {
  upsertAccount,
  archiveAccount,
  toggleAccountActive,
  adjustAccountBalance,
  updatePhysicalCard,
} = await import("./actions");

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

  it("creates a physical_cards row with the shared cupo when physicalCard is passed", async () => {
    await upsertAccount({
      name: `${MARKER}-shared`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: { currency: "COP", balance: 0 },
      secondary: { currency: "USD", balance: 0 },
      physicalCard: {
        creditLimitCents: 20_000_000_00,
        cutoffDay: 15,
        last4: "7291",
        network: "mastercard",
      },
    });
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-shared`)));
    expect(rows).toHaveLength(2);
    const pcId = rows[0].physicalCardId!;
    const [pc] = await db.select().from(physicalCards).where(eq(physicalCards.id, pcId));
    expect(pc).toBeDefined();
    expect(pc.creditLimitCents).toBe(BigInt(20_000_000_00));
    expect(pc.statementCutoffDay).toBe(15);
    expect(pc.last4).toBe("7291");
    expect(pc.network).toBe("mastercard");
    // Sub-accounts MUST NOT carry the shared-cupo keys — single source of truth.
    expect(rows[0].metadata.creditLimitCents).toBeUndefined();
    expect(rows[1].metadata.creditLimitCents).toBeUndefined();
    expect(rows[0].metadata.cutoffDay).toBeUndefined();
    expect(rows[1].metadata.cutoffDay).toBeUndefined();
  });

  it("updatePhysicalCard updates shared cupo and attributes", async () => {
    await upsertAccount({
      name: `${MARKER}-update`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: { currency: "COP", balance: 0 },
      secondary: { currency: "USD", balance: 0 },
      physicalCard: { creditLimitCents: 10_000_000_00, cutoffDay: 10, network: "mastercard" },
    });
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-update`)));
    const pcId = rows[0].physicalCardId!;

    const result = await updatePhysicalCard({
      id: pcId,
      creditLimitCents: 25_000_000_00,
      statementCutoffDay: 15,
      last4: "7291",
      network: "mastercard",
    });
    expect(result.ok).toBe(true);
    const [pc] = await db.select().from(physicalCards).where(eq(physicalCards.id, pcId));
    expect(pc.creditLimitCents).toBe(BigInt(25_000_000_00));
    expect(pc.statementCutoffDay).toBe(15);
    expect(pc.last4).toBe("7291");
    // Sub-accounts are untouched.
    const [refreshed] = await db.select().from(accounts).where(eq(accounts.id, rows[0].id));
    expect(refreshed.balanceCents).toBe(BigInt(0));
    expect(refreshed.metadata.creditLimitCents).toBeUndefined();
  });

  it("updatePhysicalCard rejects when the uuid belongs to another user (tenancy guard)", async () => {
    // Create a physical card under OTHER_USER_ID directly via the DB (bypassing
    // the upsert helper which uses the mocked session user).
    const [otherUser] = await db
      .insert(users)
      .values({ email: `${MARKER}-cross-tenant@test.local`, name: "Other" })
      .returning({ id: users.id });
    const { randomUUID } = await import("node:crypto");
    const pcId = randomUUID();
    await db.insert(physicalCards).values({
      id: pcId,
      userId: otherUser.id,
      institution: "Bancolombia",
      creditLimitCents: BigInt(99_999),
    });

    const result = await updatePhysicalCard({
      id: pcId,
      creditLimitCents: 1_000_000_00,
    });
    expect(result.ok).toBe(false);
    // Row is unchanged.
    const [unchanged] = await db.select().from(physicalCards).where(eq(physicalCards.id, pcId));
    expect(unchanged.creditLimitCents).toBe(BigInt(99_999));

    // Cleanup.
    await db.execute(sql`DELETE FROM physical_cards WHERE id = ${pcId}`);
    await db.execute(sql`DELETE FROM users WHERE email = ${MARKER + "-cross-tenant@test.local"}`);
  });

  it("rejects physicalCard without secondary (single-currency CCs use metadata)", async () => {
    await expect(
      upsertAccount({
        name: `${MARKER}-bad`,
        institution: "Bancolombia",
        type: "credit_card",
        primary: { currency: "COP", balance: 0 },
        physicalCard: { creditLimitCents: 100_000 },
      }),
    ).rejects.toThrow();
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
      declared: { kind: "balance", balanceCents: 12_000_000 },
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
    const result = await adjustAccountBalance({
      accountId,
      declared: { kind: "balance", balanceCents: 8_000_000 },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.diffCents).toBe("-2000000");
    }
  });

  it("no-op when declared matches current", async () => {
    const accountId = await seedAccount(100_000);
    const result = await adjustAccountBalance({
      accountId,
      declared: { kind: "balance", balanceCents: 10_000_000 },
    });
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

    const result = await adjustAccountBalance({
      accountId,
      declared: { kind: "balance", balanceCents: 11_000_000 },
    });
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
      declared: { kind: "balance", balanceCents: 200_000_00 },
    });
    expect(result.status).toBe("error");

    await db.execute(sql`DELETE FROM accounts WHERE id = ${otherAccount.id}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${otherUser.id}`);
  });

  it("notAdjustment helper filters adjustment rows from spend queries", async () => {
    const accountId = await seedAccount(100_000);
    await adjustAccountBalance({
      accountId,
      declared: { kind: "balance", balanceCents: 11_500_000 },
    });

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

  // #328: credit card balance tracks DEBT as a negative number. The bank
  // app never shows debt directly — it shows the available limit ("cupo"),
  // so the user declares that and the server derives the debt.
  describe("credit_card adjustBalance via availableCredit", () => {
    async function seedCreditCard(opts: {
      creditLimit?: number;
      balanceCents?: number;
      availableCredit?: number;
    }): Promise<number> {
      const metadata: AccountMetadata = {};
      if (opts.creditLimit !== undefined) metadata.creditLimitCents = opts.creditLimit;
      if (opts.availableCredit !== undefined) metadata.availableCreditCents = opts.availableCredit;
      const [row] = await db
        .insert(accounts)
        .values({
          userId: TEST_USER_ID,
          name: `${ADJ_MARKER}-cc`,
          institution: "Bancolombia",
          type: "credit_card",
          currency: "COP",
          balanceCents: BigInt(opts.balanceCents ?? 0),
          metadata,
        })
        .returning({ id: accounts.id });
      return row.id;
    }

    it("derives debt from cupo and stores balance as negative", async () => {
      const accountId = await seedCreditCard({ creditLimit: 5_000_000, balanceCents: 0 });

      const result = await adjustAccountBalance({
        accountId,
        declared: { kind: "availableCredit", availableCreditCents: 3_200_000 },
        reason: "cupo según app del banco",
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // debt = limit - available = 1_800_000 → balance_cents = -1_800_000
        // diff = -1_800_000 - 0 = -1_800_000
        expect(result.diffCents).toBe("-1800000");
      }

      const [after] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(after.balanceCents).toBe(BigInt(-1_800_000));
      expect(after.metadata.availableCreditCents).toBe(3_200_000);
      expect(after.metadata.creditLimitCents).toBe(5_000_000);
    });

    it("refuses when the account has no creditLimitCents in metadata", async () => {
      const accountId = await seedCreditCard({ balanceCents: 0 });

      const result = await adjustAccountBalance({
        accountId,
        declared: { kind: "availableCredit", availableCreditCents: 3_200_000 },
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/límite|creditLimit|cupo/i);
      }
    });

    it("refuses availableCredit larger than the limit (sanity check)", async () => {
      const accountId = await seedCreditCard({ creditLimit: 5_000_000, balanceCents: 0 });

      const result = await adjustAccountBalance({
        accountId,
        declared: { kind: "availableCredit", availableCreditCents: 6_000_000 },
      });

      expect(result.status).toBe("error");
    });

    it("refuses kind=availableCredit on a non-credit_card account", async () => {
      const accountId = await seedAccount(100_000); // savings

      const result = await adjustAccountBalance({
        accountId,
        declared: { kind: "availableCredit", availableCreditCents: 1_000_000 },
      });

      expect(result.status).toBe("error");
    });
  });
});
