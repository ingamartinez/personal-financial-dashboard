import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  classificationRules,
  emailReceipts,
  gmailConnections,
  transactions,
  users,
} from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { applyEnrichment } from "./enrich";

// Controls whether reclassifyTransaction should throw. Shared via vi.hoisted
// so the factory inside vi.mock() can read it before top-level consts are set.
const { shouldReclassifyThrow } = vi.hoisted(() => ({ shouldReclassifyThrow: { value: false } }));

vi.mock("@/lib/classification/reclassify", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/classification/reclassify")>();
  return {
    ...original,
    reclassifyTransaction: vi.fn(
      async (
        userId: number,
        txId: number,
        database?: import("@/lib/classification/reclassify").ReclassifyDb,
      ) => {
        if (shouldReclassifyThrow.value) {
          throw new Error("injected reclassify failure for rollback test");
        }
        return original.reclassifyTransaction(userId, txId, database);
      },
    ),
  };
});

const TAG = "VITEST_ENRICH_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let userB: number;
let accountA: number;
let accountB: number;
let connA: number;
let connB: number;

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM classification_rules WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM transactions WHERE account_id IN (${accountA}, ${accountB})`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}${suffix}@test.local`, name: `${TAG}${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

async function createAccount(userId: number, suffix: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}${suffix}`,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createConnection(userId: number): Promise<number> {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}${userId}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

async function createTx(userId: number, acctId: number, descriptionRaw: string): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId: acctId,
      occurredAt: new Date("2026-04-19T10:00:00Z"),
      amountCents: BigInt(-65990),
      currency: "COP",
      descriptionRaw,
      classificationMethod: "unclassified",
      source: "sms",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function createReceipt(
  userId: number,
  connId: number,
  merchant: string,
  msgSuffix?: string,
): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: `${TAG}receipt-${msgSuffix ?? Date.now()}-${Math.random()}`,
      gateway: "mercado_pago",
      amountCents: BigInt(65990),
      occurredAt: new Date("2026-04-19T10:00:00Z"),
      merchant,
      rawHtml: "<html>test</html>",
      matchStatus: "pending",
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

async function getTxState(id: number) {
  const [row] = await db
    .select({
      descriptionRaw: transactions.descriptionRaw,
      enrichedMerchant: transactions.enrichedMerchant,
      enrichmentSource: transactions.enrichmentSource,
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
    })
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
}

async function getReceiptState(id: number) {
  const [row] = await db
    .select({
      matchStatus: emailReceipts.matchStatus,
      matchedTransactionId: emailReceipts.matchedTransactionId,
    })
    .from(emailReceipts)
    .where(eq(emailReceipts.id, id));
  return row;
}

beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  userA = await createUser("A");
  userB = await createUser("B");
  accountA = await createAccount(userA, "A");
  accountB = await createAccount(userB, "B");
  connA = await createConnection(userA);
  connB = await createConnection(userB);

  // Seed categories required by FK constraints.
  await db.insert(categories).values([
    {
      userId: userA,
      slug: "delivery",
      name: "Delivery",
      icon: "truck",
      color: "#3b82f6",
      sortOrder: 1,
    },
    {
      userId: userB,
      slug: "delivery",
      name: "Delivery",
      icon: "truck",
      color: "#3b82f6",
      sortOrder: 1,
    },
  ]);
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM categories WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM accounts WHERE id IN (${accountA}, ${accountB})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

describe("applyEnrichment — multi-tenant isolation", () => {
  it("throws cross-tenant error when receipt belongs to a different user", async () => {
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA A");
    const receiptId = await createReceipt(userB, connB, "Rappi", "cross");

    await expect(applyEnrichment(userA, txId, receiptId)).rejects.toThrow(/cross-tenant/);
  });

  it("throws cross-tenant error when transaction belongs to a different user", async () => {
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA B");
    const receiptId = await createReceipt(userB, connB, "Rappi", "cross2");

    // userB tries to enrich userA's tx with their own receipt
    await expect(applyEnrichment(userB, txId, receiptId)).rejects.toThrow(/cross-tenant/);
  });
});

describe("applyEnrichment — functional", () => {
  it("sets enrichedMerchant and enrichmentSource on the transaction", async () => {
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA 001");
    const receiptId = await createReceipt(userA, connA, "Rappi");

    await applyEnrichment(userA, txId, receiptId);

    const tx = await getTxState(txId);
    expect(tx.enrichedMerchant).toBe("Rappi");
    expect(tx.enrichmentSource).toBe("gmail");
  });

  it("sets matchStatus=matched and matchedTransactionId on the receipt", async () => {
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA 002");
    const receiptId = await createReceipt(userA, connA, "Rappi");

    await applyEnrichment(userA, txId, receiptId);

    const receipt = await getReceiptState(receiptId);
    expect(receipt.matchStatus).toBe("matched");
    expect(receipt.matchedTransactionId).toBe(txId);
  });

  it("preserves descriptionRaw (audit trail is immutable)", async () => {
    const original = "MERCADOPAGO COLOMBIA audit-check";
    const txId = await createTx(userA, accountA, original);
    const receiptId = await createReceipt(userA, connA, "Rappi");

    await applyEnrichment(userA, txId, receiptId);

    const tx = await getTxState(txId);
    expect(tx.descriptionRaw).toBe(original);
  });

  it("applies rule_retroactive classification when a matching rule exists", async () => {
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA classify");
    const receiptId = await createReceipt(userA, connA, "Rappi");

    await db.insert(classificationRules).values({
      userId: userA,
      pattern: "%Rappi%",
      categorySlug: "delivery",
      priority: 5,
      active: true,
    });

    await applyEnrichment(userA, txId, receiptId);

    const tx = await getTxState(txId);
    expect(tx.categorySlug).toBe("delivery");
    expect(tx.classificationMethod).toBe("rule_retroactive");
  });

  it("throws on cross-tenant attempt before issuing any write", async () => {
    // The cross-tenant check in enrich.ts runs before the first UPDATE, so the
    // throw happens before any write — this test validates the guard, NOT rollback.
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA atomic");
    const receiptIdWrong = await createReceipt(userB, connB, "Rappi", "atomic-wrong");

    await expect(applyEnrichment(userA, txId, receiptIdWrong)).rejects.toThrow(/cross-tenant/);

    // Neither row should be modified (no write was ever issued).
    const tx = await getTxState(txId);
    expect(tx.enrichedMerchant).toBeNull();

    const receipt = await getReceiptState(receiptIdWrong);
    expect(receipt.matchStatus).toBe("pending");
  });

  it("rolls back tx update if reclassify step fails mid-transaction", async () => {
    // Both updates (transactions + email_receipts) execute inside db.transaction
    // before reclassifyTransaction is called. Injecting a failure in reclassify
    // proves Drizzle rolls back both — if the transaction were absent, both UPDATEs
    // would persist.
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA rollback");
    const receiptId = await createReceipt(userA, connA, "Rappi", "rollback");

    shouldReclassifyThrow.value = true;
    try {
      await expect(applyEnrichment(userA, txId, receiptId)).rejects.toThrow(
        /injected reclassify failure/,
      );
    } finally {
      shouldReclassifyThrow.value = false;
    }

    // Re-query outside the failed transaction scope — both rows must be pristine.
    const tx = await getTxState(txId);
    expect(tx.enrichedMerchant).toBeNull();
    expect(tx.enrichmentSource).toBeNull();

    const receipt = await getReceiptState(receiptId);
    expect(receipt.matchStatus).toBe("pending");
    expect(receipt.matchedTransactionId).toBeNull();
  });
});

describe("applyEnrichment — idempotency", () => {
  it("calling twice with same args produces identical state", async () => {
    const txId = await createTx(userA, accountA, "MERCADOPAGO COLOMBIA idem");
    const receiptId = await createReceipt(userA, connA, "Rappi");

    await applyEnrichment(userA, txId, receiptId);
    const tx1 = await getTxState(txId);
    const receipt1 = await getReceiptState(receiptId);

    // Second call: receipt is already matched=matched, tx is already enriched.
    // The cross-tenant check still passes since both rows belong to userA.
    await applyEnrichment(userA, txId, receiptId);
    const tx2 = await getTxState(txId);
    const receipt2 = await getReceiptState(receiptId);

    expect(tx1).toEqual(tx2);
    expect(receipt1).toEqual(receipt2);
  });
});
