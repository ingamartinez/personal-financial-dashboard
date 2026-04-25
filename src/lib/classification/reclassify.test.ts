import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, classificationRules, transactions, users } from "@/lib/db/schema";
import { reclassifyTransaction } from "./reclassify";

const TAG = "VITEST_RECLASSIFY_";

let userId: number;
let accountId: number;

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM classification_rules WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM transactions WHERE account_id = ${accountId}`);
}

async function createTx(overrides: {
  descriptionRaw?: string;
  enrichedMerchant?: string | null;
  categorySlug?: string;
  classificationMethod?:
    | "rule"
    | "ai"
    | "manual"
    | "unclassified"
    | "rule_retroactive"
    | "manual_confirmed";
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-19T12:00:00Z"),
      amountCents: BigInt(-65990),
      currency: "COP",
      descriptionRaw: overrides.descriptionRaw ?? `${TAG}tx`,
      enrichedMerchant: overrides.enrichedMerchant ?? null,
      categorySlug: overrides.categorySlug ?? null,
      classificationMethod: overrides.classificationMethod ?? "unclassified",
      source: "sms",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function insertRule(pattern: string, categorySlug: string): Promise<number> {
  const [row] = await db
    .insert(classificationRules)
    .values({ userId, pattern, categorySlug, priority: 10, active: true })
    .returning({ id: classificationRules.id });
  return row.id;
}

async function getTx(id: number) {
  const [row] = await db
    .select({
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      classificationConfidence: transactions.classificationConfidence,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  return row;
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: `${TAG}user@test.local`, name: `${TAG}user` })
    .returning({ id: users.id });
  userId = u.id;

  const [a] = await db
    .insert(accounts)
    .values({ userId, name: `${TAG}acct`, institution: "Test", type: "savings", currency: "COP" })
    .returning({ id: accounts.id });
  accountId = a.id;

  // Seed categories required by FK constraints.
  await db.insert(categories).values([
    { userId, slug: "food", name: "Food", icon: "utensils", color: "#ef4444", sortOrder: 1 },
    { userId, slug: "delivery", name: "Delivery", icon: "truck", color: "#3b82f6", sortOrder: 2 },
    { userId, slug: "otros", name: "Otros", icon: "circle", color: "#6b7280", sortOrder: 99 },
  ]);
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM categories WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM accounts WHERE id = ${accountId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
});

describe("reclassifyTransaction", () => {
  it("no-ops when enrichedMerchant is null", async () => {
    const txId = await createTx({ categorySlug: "food", classificationMethod: "manual" });
    await reclassifyTransaction(userId, txId);
    const after = await getTx(txId);
    expect(after.classificationMethod).toBe("manual");
    expect(after.categorySlug).toBe("food");
  });

  it("no-ops when no rule matches enrichedMerchant", async () => {
    const txId = await createTx({
      enrichedMerchant: "Rappi",
      categorySlug: "food",
      classificationMethod: "ai",
    });
    // Rule that does NOT match "Rappi"
    await insertRule(`%${TAG}NOMATCH%`, "otros");

    await reclassifyTransaction(userId, txId);
    const after = await getTx(txId);
    expect(after.classificationMethod).toBe("ai");
    expect(after.categorySlug).toBe("food");
  });

  it("applies rule_retroactive classification when rule matches enrichedMerchant", async () => {
    const txId = await createTx({
      descriptionRaw: "MERCADOPAGO COLOMBIA 123",
      enrichedMerchant: "Rappi",
      classificationMethod: "unclassified",
    });
    const ruleId = await insertRule("%Rappi%", "delivery");

    await reclassifyTransaction(userId, txId);
    const after = await getTx(txId);
    expect(after.categorySlug).toBe("delivery");
    expect(after.classificationMethod).toBe("rule_retroactive");
    expect(after.classificationConfidence).toBe(100);
    expect(after.classificationReason).toBe(
      `rule_retroactive: matched rule #${ruleId} via enriched_merchant`,
    );
  });

  it("is idempotent: calling twice produces identical state", async () => {
    const txId = await createTx({
      enrichedMerchant: "Rappi",
      classificationMethod: "unclassified",
    });
    await insertRule("%Rappi%", "delivery");

    await reclassifyTransaction(userId, txId);
    const after1 = await getTx(txId);

    await reclassifyTransaction(userId, txId);
    const after2 = await getTx(txId);

    expect(after1).toEqual(after2);
  });

  it("gracefully handles unknown txId without throwing", async () => {
    await expect(reclassifyTransaction(userId, 999_999_999)).resolves.toBeUndefined();
  });
});
