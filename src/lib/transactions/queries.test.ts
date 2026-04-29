import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, transactions, users } from "@/lib/db/schema";
import { countTotal, listTransactions } from "./queries";

const MARKER = "__test_tx_queries";
let USER_ID = 0;
let ACCOUNT_ID = 0;

async function cleanup() {
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE ${MARKER + "%"}`);
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: `${MARKER}@test.local`, name: "Tx Queries" })
    .returning({ id: users.id });
  USER_ID = u.id;

  await db.insert(categories).values({
    userId: USER_ID,
    slug: "adjustments",
    name: "Ajustes de saldo",
    icon: "wrench",
    color: "#475569",
    sortOrder: 1000,
  });
  await db.insert(categories).values({
    userId: USER_ID,
    slug: "food",
    name: "Alimentación",
    icon: "utensils",
    color: "#ef4444",
    sortOrder: 1,
  });

  const [a] = await db
    .insert(accounts)
    .values({
      userId: USER_ID,
      name: `${MARKER}-acct`,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  ACCOUNT_ID = a.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM transactions WHERE account_id = ${ACCOUNT_ID}`);
  await db.execute(sql`DELETE FROM accounts WHERE id = ${ACCOUNT_ID}`);
  await db.execute(sql`DELETE FROM categories WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
});

async function seedRows() {
  await db.insert(transactions).values([
    {
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      occurredAt: new Date("2026-04-10T12:00:00Z"),
      amountCents: BigInt(-5000),
      currency: "COP",
      descriptionRaw: `${MARKER}-food-1`,
      categorySlug: "food",
      classificationMethod: "manual",
      source: "manual",
    },
    {
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      occurredAt: new Date("2026-04-11T12:00:00Z"),
      amountCents: BigInt(-7500),
      currency: "COP",
      descriptionRaw: `${MARKER}-food-2`,
      categorySlug: "food",
      classificationMethod: "manual",
      source: "manual",
    },
    {
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      occurredAt: new Date("2026-04-12T12:00:00Z"),
      amountCents: BigInt(10000),
      currency: "COP",
      descriptionRaw: `${MARKER}-adj`,
      categorySlug: "adjustments",
      classificationMethod: "manual",
      source: "balance_adjustment",
      channel: "manual",
      isAdjustment: true,
    },
  ]);
}

describe("listTransactions hideAdjustments", () => {
  afterEach(cleanup);

  it("includes adjustments when filter is omitted", async () => {
    await seedRows();
    const { rows } = await listTransactions(USER_ID, {});
    const mine = rows.filter((r) => r.descriptionRaw.startsWith(MARKER));
    expect(mine).toHaveLength(3);
    expect(mine.some((r) => r.isAdjustment)).toBe(true);
  });

  it("includes adjustments when hideAdjustments=false", async () => {
    await seedRows();
    const { rows } = await listTransactions(USER_ID, { hideAdjustments: false });
    const mine = rows.filter((r) => r.descriptionRaw.startsWith(MARKER));
    expect(mine).toHaveLength(3);
  });

  it("excludes adjustments when hideAdjustments=true", async () => {
    await seedRows();
    const { rows } = await listTransactions(USER_ID, { hideAdjustments: true });
    const mine = rows.filter((r) => r.descriptionRaw.startsWith(MARKER));
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => !r.isAdjustment)).toBe(true);
  });

  it("composes with other filters (category + hideAdjustments)", async () => {
    await seedRows();
    const { rows } = await listTransactions(USER_ID, {
      categorySlug: "adjustments",
      hideAdjustments: true,
    });
    const mine = rows.filter((r) => r.descriptionRaw.startsWith(MARKER));
    expect(mine).toHaveLength(0);
  });
});

describe("countTotal hideAdjustments", () => {
  afterEach(cleanup);

  it("counts all rows when filter is omitted", async () => {
    await seedRows();
    const n = await countTotal(USER_ID, {});
    expect(n).toBe(3);
  });

  it("excludes adjustments when hideAdjustments=true", async () => {
    await seedRows();
    const n = await countTotal(USER_ID, { hideAdjustments: true });
    expect(n).toBe(2);
  });
});

// #642: transferGroupId must be present in TxRow shape and populated for
// paired transfer rows.
describe("listTransactions transferGroupId", () => {
  const PAIR_GROUP = "39ef646a-eb58-4259-9bfc-e1c62e75fc26";

  afterEach(async () => {
    await db.execute(
      sql`DELETE FROM transactions WHERE description_raw LIKE ${"__test_tx_transfer%"}`,
    );
  });

  it("returns transferGroupId=null for regular transactions", async () => {
    await db.insert(transactions).values({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      occurredAt: new Date("2026-04-15T12:00:00Z"),
      amountCents: BigInt(-3000),
      currency: "COP",
      descriptionRaw: "__test_tx_transfer-regular",
      categorySlug: "food",
      classificationMethod: "manual",
      source: "manual",
    });

    const { rows } = await listTransactions(USER_ID, {});
    const row = rows.find((r) => r.descriptionRaw === "__test_tx_transfer-regular");
    expect(row).toBeDefined();
    expect(row!.transferGroupId).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(row, "transferGroupId")).toBe(true);
  });

  it("returns matching transferGroupId for both legs of a paired transfer", async () => {
    await db.insert(transactions).values([
      {
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        occurredAt: new Date("2026-04-16T10:00:00Z"),
        amountCents: BigInt(-500000),
        currency: "COP",
        descriptionRaw: "__test_tx_transfer-leg-a",
        categorySlug: null,
        classificationMethod: "manual",
        source: "sms",
        channel: "transfer",
        transferGroupId: PAIR_GROUP,
      },
      {
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        occurredAt: new Date("2026-04-16T10:00:00Z"),
        amountCents: BigInt(500000),
        currency: "COP",
        descriptionRaw: "__test_tx_transfer-leg-b",
        categorySlug: null,
        classificationMethod: "manual",
        source: "sms",
        channel: "transfer",
        transferGroupId: PAIR_GROUP,
      },
    ]);

    const { rows } = await listTransactions(USER_ID, {});
    const legA = rows.find((r) => r.descriptionRaw === "__test_tx_transfer-leg-a");
    const legB = rows.find((r) => r.descriptionRaw === "__test_tx_transfer-leg-b");

    expect(legA).toBeDefined();
    expect(legB).toBeDefined();
    expect(legA!.transferGroupId).toBe(PAIR_GROUP);
    expect(legB!.transferGroupId).toBe(PAIR_GROUP);
    expect(legA!.channel).toBe("transfer");
    expect(legB!.channel).toBe("transfer");
  });
});
