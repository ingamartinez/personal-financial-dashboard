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

// #368: account balance is derived from SUM(transactions.amount_cents).
async function derivedBalance(accountId: number): Promise<bigint> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${transactions.amountCents}), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));
  return BigInt(row.total);
}

async function cleanup() {
  // transactions.account_id FK is ON DELETE RESTRICT — purge txs (including
  // opening-balance txs inserted on upsertAccount create, #368) before the
  // accounts they reference.
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${MARKER + "%"})`,
  );
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
    // #370: balance_cents column is gone; the declared opening balance is
    // persisted as a 'Saldo inicial' tx on the ledger (#368).
    expect(await derivedBalance(row.id)).toBe(BigInt(120_000_000));
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

  it("updates metadata on an existing account via id (balance is ledger-only, unchanged by upsert edit)", async () => {
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
      primary: {
        currency: "COP",
        balance: 750_000, // ignored on edit — users adjust balance via the adjust flow
        metadata: { last4s: ["1234"] },
      },
    });

    const [after] = await db.select().from(accounts).where(eq(accounts.id, before.id));
    // #370: upsertAccount's edit path no longer writes balance — it only
    // touches currency + metadata. The declared opening balance persists
    // as the single 'Saldo inicial' tx created on original upsert.
    expect(after.metadata.last4s).toEqual(["1234"]);
    expect(await derivedBalance(before.id)).toBe(BigInt(50_000_000));
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

  it("persists cutoffDay + creditLimit in metadata for single-currency credit_card", async () => {
    await upsertAccount({
      name: `${MARKER}-cc-cutoff`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: {
        currency: "COP",
        balance: -100_000,
        metadata: { creditLimitCents: 5_000_000_00, cutoffDay: 10 },
      },
    });
    const [row] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-cc-cutoff`)));
    expect(row).toBeDefined();
    expect(row.physicalCardId).toBeNull();
    expect(row.metadata.cutoffDay).toBe(10);
    expect(row.metadata.creditLimitCents).toBe(5_000_000_00);
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

  it("persists name to physical_cards on multi-currency creation (#362)", async () => {
    await upsertAccount({
      name: `${MARKER}-mc-name`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: { currency: "COP", balance: 0 },
      secondary: { currency: "USD", balance: 0 },
      physicalCard: {
        creditLimitCents: 15_000_000_00,
        cutoffDay: 10,
        last4: "7291",
        network: "mastercard",
      },
    });
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-mc-name`)));
    expect(rows).toHaveLength(2);
    const [pc] = await db
      .select()
      .from(physicalCards)
      .where(eq(physicalCards.id, rows[0].physicalCardId!));
    // name defaults to the account name when physicalCard.name is not passed.
    expect(pc.name).toBe(`${MARKER}-mc-name`);
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
    expect(await derivedBalance(refreshed.id)).toBe(BigInt(0));
    expect(refreshed.metadata.creditLimitCents).toBeUndefined();
  });

  it("updatePhysicalCard applies partial updates — undefined leaves fields untouched (#362)", async () => {
    await upsertAccount({
      name: `${MARKER}-partial`,
      institution: "Bancolombia",
      type: "credit_card",
      primary: { currency: "COP", balance: 0 },
      secondary: { currency: "USD", balance: 0 },
      physicalCard: {
        name: "Initial Name",
        creditLimitCents: 10_000_000_00,
        cutoffDay: 10,
        last4: "7291",
        network: "mastercard",
      },
    });
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${MARKER}-partial`)));
    const pcId = rows[0].physicalCardId!;

    // 🎫 path: only touches cupo + network. cutoff / last4 / name stay intact.
    await updatePhysicalCard({
      id: pcId,
      creditLimitCents: 20_000_000_00,
      network: "visa",
    });
    const [pcAfterMinimal] = await db
      .select()
      .from(physicalCards)
      .where(eq(physicalCards.id, pcId));
    expect(pcAfterMinimal.creditLimitCents).toBe(BigInt(20_000_000_00));
    expect(pcAfterMinimal.network).toBe("visa");
    expect(pcAfterMinimal.statementCutoffDay).toBe(10); // untouched
    expect(pcAfterMinimal.last4).toBe("7291"); // untouched
    expect(pcAfterMinimal.name).toBe("Initial Name"); // untouched

    // ✏️ path: only name / cutoff / last4; cupo + network untouched.
    await updatePhysicalCard({
      id: pcId,
      name: "Renamed Card",
      statementCutoffDay: 22,
      last4: "1234",
    });
    const [pcAfterEdit] = await db.select().from(physicalCards).where(eq(physicalCards.id, pcId));
    expect(pcAfterEdit.name).toBe("Renamed Card");
    expect(pcAfterEdit.statementCutoffDay).toBe(22);
    expect(pcAfterEdit.last4).toBe("1234");
    expect(pcAfterEdit.creditLimitCents).toBe(BigInt(20_000_000_00)); // untouched
    expect(pcAfterEdit.network).toBe("visa"); // untouched
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
    // transactions.account_id FK is RESTRICT — purge ALL txs on the marker
    // accounts (includes 'Saldo inicial' openings from upsertAccount and
    // 'Ajuste de saldo' rows from adjustAccountBalance) before deleting
    // the accounts themselves.
    await db.execute(
      sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${ADJ_MARKER + "%"})`,
    );
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

    expect(await derivedBalance(accountId)).toBe(BigInt(12_000_000));
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

    // Only the 'Saldo inicial' opening-balance tx should exist (from
    // seedAccount) — the no-op adjust must not insert anything new.
    const txs = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          sql`${transactions.descriptionRaw} LIKE 'Ajuste de saldo%'`,
        ),
      );
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
          metadata,
        })
        .returning({ id: accounts.id });
      return row.id;
    }

    it("derives debt from cupo and stores balance as negative", async () => {
      const accountId = await seedCreditCard({ creditLimit: 5_000_000 });

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
      expect(await derivedBalance(accountId)).toBe(BigInt(-1_800_000));
      // #420: cupo is NOT snapshotted anymore — display derives from limit + ledger.
      expect(after.metadata.availableCreditCents).toBeUndefined();
      expect(after.metadata.creditLimitCents).toBe(5_000_000);
    });

    it("#420: strips a stale availableCreditCents snapshot on adjust", async () => {
      // Legacy row written under the pre-#420 model. The stale value must be
      // stripped so display stops reading it and starts deriving from ledger.
      const accountId = await seedCreditCard({
        creditLimit: 5_000_000,
        availableCredit: 4_000_000, // stale — ledger says 0 debt → real available=5M
      });

      const result = await adjustAccountBalance({
        accountId,
        declared: { kind: "availableCredit", availableCreditCents: 3_200_000 },
      });

      expect(result.status).toBe("ok");
      const [after] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(after.metadata.availableCreditCents).toBeUndefined();
      expect(after.metadata.creditLimitCents).toBe(5_000_000);
    });

    it("#420: strips stale availableCreditCents even on no-op (declared matches)", async () => {
      // Ledger balance=0, stale snapshot=4M, limit=5M → declared=5M means
      // debt=0, target balance matches current → diff=0 (noop). Strip still lands.
      const accountId = await seedCreditCard({
        creditLimit: 5_000_000,
        availableCredit: 4_000_000,
      });

      const result = await adjustAccountBalance({
        accountId,
        declared: { kind: "availableCredit", availableCreditCents: 5_000_000 },
      });

      expect(result.status).toBe("noop");
      const [after] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(after.metadata.availableCreditCents).toBeUndefined();
      expect(after.metadata.creditLimitCents).toBe(5_000_000);
    });

    it("refuses when the account has no creditLimitCents in metadata", async () => {
      const accountId = await seedCreditCard({});

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
      const accountId = await seedCreditCard({ creditLimit: 5_000_000 });

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

  describe("kind: sharedAvailableCop (#346 multi-currency)", () => {
    // Seed a *7291-like pair with a known limit + balances. Returns COP sub id
    // and USD sub id for the assertions.
    async function seedPair(params: {
      limitCents: number;
      copBalanceCents: number;
      usdBalanceCents: number;
    }): Promise<{ copId: number; usdId: number; pcId: string }> {
      await upsertAccount({
        name: `${ADJ_MARKER}-pair`,
        institution: "Bancolombia",
        type: "credit_card",
        primary: { currency: "COP", balance: params.copBalanceCents / 100 },
        secondary: { currency: "USD", balance: params.usdBalanceCents / 100 },
        physicalCard: { creditLimitCents: params.limitCents, network: "mastercard" },
      });
      const rows = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${ADJ_MARKER}-pair`)));
      const cop = rows.find((r) => r.currency === "COP")!;
      const usd = rows.find((r) => r.currency === "USD")!;
      return { copId: cop.id, usdId: usd.id, pcId: cop.physicalCardId! };
    }

    async function stubFxRate(rate: number) {
      // Direct upsert into fx_rates for today so getCurrentFxRate returns the
      // deterministic rate for the test (keeps the math predictable).
      await db.execute(sql`
        INSERT INTO fx_rates (base, quote, rate_micros, as_of, source)
        VALUES ('USD', 'COP', ${BigInt(Math.round(rate * 1_000_000))}, CURRENT_DATE, 'test')
        ON CONFLICT (base, quote, as_of) DO UPDATE SET
          rate_micros = EXCLUDED.rate_micros,
          source = EXCLUDED.source,
          fetched_at = NOW()
      `);
    }

    afterEach(async () => {
      await db.execute(sql`DELETE FROM fx_rates WHERE source = 'test'`);
    });

    it("AS-4: adjusts only the COP sub when the target is COP", async () => {
      // Limit 20MM COP, COP balance -500k, USD balance -100 USD, TRM 4100.
      // User enters cupo disponible = 18.5MM COP.
      // Expected: total_debt = 1.5MM, sibling (USD) debt = 100 × 4100 = 410k,
      // target COP debt = 1.5MM - 410k = 1.090MM → new COP balance = -1.090MM.
      await stubFxRate(4100);
      const { copId, usdId } = await seedPair({
        limitCents: 20_000_000_00,
        copBalanceCents: -500_000_00,
        usdBalanceCents: -100_00,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: { kind: "sharedAvailableCop", availableCopCents: 18_500_000_00 },
      });

      expect(result.status).toBe("ok");
      expect(await derivedBalance(copId)).toBe(BigInt(-1_090_000_00));
      // USD sub is untouched.
      expect(await derivedBalance(usdId)).toBe(BigInt(-100_00));
    });

    it("AS-5: adjusts only the USD sub when the target is USD (back-solve through TRM)", async () => {
      // Limit 20MM, COP -500k, USD -100 USD, TRM 4100. User enters 19MM COP.
      // Expected: total_debt = 1MM COP; sibling (COP) debt = 500k; remaining
      // USD debt = 500k COP / 4100 = 121.95 USD → 12_195 USD cents → -12195.
      await stubFxRate(4100);
      const { copId, usdId } = await seedPair({
        limitCents: 20_000_000_00,
        copBalanceCents: -500_000_00,
        usdBalanceCents: -100_00,
      });

      const result = await adjustAccountBalance({
        accountId: usdId,
        declared: { kind: "sharedAvailableCop", availableCopCents: 19_000_000_00 },
      });

      expect(result.status).toBe("ok");
      // 500_000_00 COP / 4100 = 12_195.12 → integer truncation = 12_195 cents USD.
      expect(await derivedBalance(usdId)).toBe(BigInt(-12_195));
      expect(await derivedBalance(copId)).toBe(BigInt(-500_000_00));
    });

    it("rejects when the physical card has no limit configured", async () => {
      await stubFxRate(4100);
      const { copId } = await seedPair({
        limitCents: 0,
        copBalanceCents: 0,
        usdBalanceCents: 0,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: { kind: "sharedAvailableCop", availableCopCents: 100_000 },
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/cupo/i);
      }
    });

    it("rejects when availableCopCents exceeds the shared cupo", async () => {
      await stubFxRate(4100);
      const { copId } = await seedPair({
        limitCents: 10_000_000_00,
        copBalanceCents: 0,
        usdBalanceCents: 0,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: { kind: "sharedAvailableCop", availableCopCents: 15_000_000_00 },
      });
      expect(result.status).toBe("error");
    });

    it("rejects kind=availableCredit on a paired sub-account (force shared path)", async () => {
      await stubFxRate(4100);
      const { copId } = await seedPair({
        limitCents: 10_000_000_00,
        copBalanceCents: 0,
        usdBalanceCents: 0,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: { kind: "availableCredit", availableCreditCents: 5_000_000_00 },
      });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/multi-moneda|cupo compartido/i);
      }
    });
  });

  // #447 — dual-debt snapshot: enter both currency debts independently so
  // drift in one sub-account never propagates to the other (unlike
  // sharedAvailableCop, which back-solves through sibling × TRM).
  describe("kind: perCurrencyDualDebt (#447)", () => {
    async function seedPair(params: {
      limitCents: number;
      copBalanceCents: number;
      usdBalanceCents: number;
    }): Promise<{ copId: number; usdId: number; pcId: string }> {
      await upsertAccount({
        name: `${ADJ_MARKER}-dual`,
        institution: "Bancolombia",
        type: "credit_card",
        primary: { currency: "COP", balance: params.copBalanceCents / 100 },
        secondary: { currency: "USD", balance: params.usdBalanceCents / 100 },
        physicalCard: { creditLimitCents: params.limitCents, network: "mastercard" },
      });
      const rows = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.name, `${ADJ_MARKER}-dual`)));
      const cop = rows.find((r) => r.currency === "COP")!;
      const usd = rows.find((r) => r.currency === "USD")!;
      return { copId: cop.id, usdId: usd.id, pcId: cop.physicalCardId! };
    }

    async function stubFxRate(rate: number) {
      await db.execute(sql`
        INSERT INTO fx_rates (base, quote, rate_micros, as_of, source)
        VALUES ('USD', 'COP', ${BigInt(Math.round(rate * 1_000_000))}, CURRENT_DATE, 'test')
        ON CONFLICT (base, quote, as_of) DO UPDATE SET
          rate_micros = EXCLUDED.rate_micros,
          source = EXCLUDED.source,
          fetched_at = NOW()
      `);
    }

    afterEach(async () => {
      await db.execute(sql`DELETE FROM fx_rates WHERE source = 'test'`);
    });

    it("snapshots both debts atomically — one balance_adjustment per sub-account", async () => {
      // Current ledger: COP -500k, USD -100 USD. Bank says: debt_cop=4.031.198,
      // debt_usd=$2.885,00 (the real MC 7291 screenshot). Expected diffs:
      //   COP: new balance -403_119_800 - current -500_000_00 = -353_119_800
      //   USD: new balance -288_500    - current -10_000     = -278_500
      await stubFxRate(3568.88);
      const { copId, usdId } = await seedPair({
        limitCents: 17_000_000_00,
        copBalanceCents: -500_000_00,
        usdBalanceCents: -100_00,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: {
          kind: "perCurrencyDualDebt",
          debtCopCents: 403_119_800,
          debtUsdCents: 288_500,
        },
      });

      expect(result.status).toBe("ok_dual");
      if (result.status !== "ok_dual") throw new Error("expected ok_dual");
      expect(result.results).toHaveLength(2);

      // Ledger settles to the declared debts exactly — no TRM-dependent math
      // leaked into either sub-account.
      expect(await derivedBalance(copId)).toBe(BigInt(-403_119_800));
      expect(await derivedBalance(usdId)).toBe(BigInt(-288_500));

      // Two balance_adjustment rows present — one per sub-account.
      const plugs = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.userId, TEST_USER_ID), eq(transactions.source, "balance_adjustment")),
        );
      const byAccount = new Map(plugs.map((p) => [p.accountId, p]));
      expect(byAccount.get(copId)?.amountCents).toBe(BigInt(-353_119_800));
      expect(byAccount.get(copId)?.currency).toBe("COP");
      expect(byAccount.get(usdId)?.amountCents).toBe(BigInt(-278_500));
      expect(byAccount.get(usdId)?.currency).toBe("USD");
      // Both flagged as adjustments so they stay out of spend/insights.
      expect(plugs.every((p) => p.isAdjustment === true)).toBe(true);
      expect(plugs.every((p) => p.categorySlug === "adjustments")).toBe(true);
    });

    it("returns noop when both declared debts match current balances exactly", async () => {
      await stubFxRate(3568.88);
      const { copId } = await seedPair({
        limitCents: 17_000_000_00,
        copBalanceCents: -403_119_800,
        usdBalanceCents: -288_500,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: {
          kind: "perCurrencyDualDebt",
          debtCopCents: 403_119_800,
          debtUsdCents: 288_500,
        },
      });

      expect(result.status).toBe("noop");
    });

    it("only inserts a plug for the side that actually changed", async () => {
      await stubFxRate(3568.88);
      const { copId, usdId } = await seedPair({
        limitCents: 17_000_000_00,
        copBalanceCents: -400_000_00,
        usdBalanceCents: -288_500, // already matches
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: {
          kind: "perCurrencyDualDebt",
          debtCopCents: 403_119_800,
          debtUsdCents: 288_500,
        },
      });

      expect(result.status).toBe("ok_dual");
      if (result.status !== "ok_dual") throw new Error("expected ok_dual");
      expect(result.results).toHaveLength(1);
      expect(result.results[0].accountId).toBe(copId);
      expect(result.results[0].currency).toBe("COP");
      expect(await derivedBalance(usdId)).toBe(BigInt(-288_500));
    });

    it("rejects when the combined debt (COP + USD×TRM) exceeds the plastic limit", async () => {
      await stubFxRate(4000);
      const { copId } = await seedPair({
        limitCents: 10_000_000_00,
        copBalanceCents: 0,
        usdBalanceCents: 0,
      });

      // 9MM COP + 500 USD × 4000 = 9MM + 2MM = 11MM > 10MM limit.
      const result = await adjustAccountBalance({
        accountId: copId,
        declared: {
          kind: "perCurrencyDualDebt",
          debtCopCents: 9_000_000_00,
          debtUsdCents: 500_00,
        },
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/cupo total/i);
      }
    });

    it("adjusts only the COP side when USD debt is omitted", async () => {
      await stubFxRate(3568.88);
      const { copId, usdId } = await seedPair({
        limitCents: 17_000_000_00,
        copBalanceCents: -500_000_00,
        usdBalanceCents: -288_500, // already matches the bank
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: {
          kind: "perCurrencyDualDebt",
          debtCopCents: 403_119_800,
          // debtUsdCents omitted — USD side stays put.
        },
      });

      expect(result.status).toBe("ok_dual");
      if (result.status !== "ok_dual") throw new Error("expected ok_dual");
      expect(result.results).toHaveLength(1);
      expect(result.results[0].accountId).toBe(copId);
      expect(await derivedBalance(copId)).toBe(BigInt(-403_119_800));
      // USD sub untouched — no new balance_adjustment on it.
      expect(await derivedBalance(usdId)).toBe(BigInt(-288_500));
    });

    it("adjusts only the USD side when COP debt is omitted", async () => {
      await stubFxRate(3568.88);
      const { copId, usdId } = await seedPair({
        limitCents: 17_000_000_00,
        copBalanceCents: -403_119_800, // already matches
        usdBalanceCents: -100_00,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: {
          kind: "perCurrencyDualDebt",
          // debtCopCents omitted — COP side stays put.
          debtUsdCents: 288_500,
        },
      });

      expect(result.status).toBe("ok_dual");
      if (result.status !== "ok_dual") throw new Error("expected ok_dual");
      expect(result.results).toHaveLength(1);
      expect(result.results[0].accountId).toBe(usdId);
      expect(await derivedBalance(usdId)).toBe(BigInt(-288_500));
      expect(await derivedBalance(copId)).toBe(BigInt(-403_119_800));
    });

    it("rejects when both debts are omitted (schema-level validation)", async () => {
      await stubFxRate(3568.88);
      const { copId } = await seedPair({
        limitCents: 17_000_000_00,
        copBalanceCents: -500_000_00,
        usdBalanceCents: -100_00,
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: { kind: "perCurrencyDualDebt" },
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/al menos una/i);
      }
    });

    it("sanity check uses current ledger on the omitted side", async () => {
      // User enters a huge COP debt alone — but USD side (on-ledger) already
      // carries 500 USD debt. Combined check must use that current USD to
      // reject the total when it overflows the limit.
      await stubFxRate(4000);
      const { copId } = await seedPair({
        limitCents: 10_000_000_00,
        copBalanceCents: 0,
        usdBalanceCents: -500_00, // $500 USD already on-ledger
      });

      const result = await adjustAccountBalance({
        accountId: copId,
        declared: {
          kind: "perCurrencyDualDebt",
          debtCopCents: 9_000_000_00, // 9M COP
          // USD omitted, but the check uses current ledger: 9M + 500×4000 = 11M > 10M
        },
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/cupo total/i);
      }
    });

    it("rejects on a single-currency TC (no physicalCardId)", async () => {
      const [cc] = await db
        .insert(accounts)
        .values({
          userId: TEST_USER_ID,
          name: `${ADJ_MARKER}-solo`,
          institution: "Bancolombia",
          type: "credit_card",
          currency: "COP",
          metadata: { creditLimitCents: 5_000_000 },
        })
        .returning({ id: accounts.id });

      const result = await adjustAccountBalance({
        accountId: cc.id,
        declared: {
          kind: "perCurrencyDualDebt",
          debtCopCents: 100_000,
          debtUsdCents: 10_000,
        },
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/multi-moneda/i);
      }
    });
  });
});
