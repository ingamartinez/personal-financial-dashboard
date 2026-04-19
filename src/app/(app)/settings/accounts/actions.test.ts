import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const { upsertAccount, archiveAccount, toggleAccountActive } = await import("./actions");

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
