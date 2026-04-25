import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { matchReceipt } from "./matcher";

const TAG = "VITEST_MATCHER_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let userB: number;
let accountA: number;
let accountB: number;
let connA: number;
let connB: number;

async function cleanup(): Promise<void> {
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

async function createTx(opts: {
  userId: number;
  accountId: number;
  amountCents: bigint;
  occurredAt: Date;
  descriptionRaw: string;
  enrichedMerchant?: string | null;
  deletedAt?: Date | null;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: opts.accountId,
      occurredAt: opts.occurredAt,
      amountCents: opts.amountCents,
      currency: "COP",
      descriptionRaw: opts.descriptionRaw,
      enrichedMerchant: opts.enrichedMerchant ?? null,
      deletedAt: opts.deletedAt ?? null,
      classificationMethod: "unclassified",
      source: "sms",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function createReceipt(opts: {
  userId: number;
  connId: number;
  gateway: "mercado_pago" | "payu" | "wompi" | "apple" | "paypal";
  amountCents: bigint;
  occurredAt: Date;
  merchant?: string;
  msgId?: string;
}): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId: opts.userId,
      gmailConnectionId: opts.connId,
      gmailMsgId: opts.msgId ?? `${TAG}${Date.now()}-${Math.random()}`,
      gateway: opts.gateway,
      amountCents: opts.amountCents,
      occurredAt: opts.occurredAt,
      merchant: opts.merchant ?? "TestMerchant",
      rawHtml: "<html>test</html>",
      matchStatus: "pending",
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  userA = await createUser("A");
  userB = await createUser("B");
  accountA = await createAccount(userA, "A");
  accountB = await createAccount(userB, "B");
  connA = await createConnection(userA);
  connB = await createConnection(userB);
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM accounts WHERE id IN (${accountA}, ${accountB})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

const AMOUNT = BigInt(65990);
const DATE = new Date("2026-04-19T10:00:00Z");

describe("matchReceipt — multi-tenant isolation", () => {
  it("does NOT match userA tx when receipt belongs to userB (cross-tenant guard)", async () => {
    // UserA has a tx that looks like a MercadoPago payment.
    await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -AMOUNT,
      occurredAt: DATE,
      descriptionRaw: "MERCADOPAGO COLOMBIA 999",
    });
    // UserB has a receipt for the same amount/date but different userId.
    const receiptId = await createReceipt({
      userId: userB,
      connId: connB,
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
    });

    const result = await matchReceipt(userB, receiptId);
    // Must NOT return the tx that belongs to userA.
    expect(result.status).toBe("unmatched");
  });

  it("throws when receipt id does not belong to caller userId", async () => {
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
    });
    // UserB tries to access userA's receipt.
    await expect(matchReceipt(userB, receiptId)).rejects.toThrow(/receipt.*not found/);
  });
});

describe("matchReceipt — functional", () => {
  it("returns matched when exactly one tx is in the window", async () => {
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -AMOUNT,
      occurredAt: DATE,
      descriptionRaw: "MERCADOPAGO COLOMBIA 001",
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
    });

    const result = await matchReceipt(userA, receiptId);
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.transactionId).toBe(txId);
    }
  });

  it("returns ambiguous with candidateIds when 2 txs are in the window", async () => {
    const tx1 = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -AMOUNT,
      occurredAt: DATE,
      descriptionRaw: "MERCADOPAGO COLOMBIA 002",
    });
    const tx2 = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -AMOUNT,
      occurredAt: new Date(DATE.getTime() + 60_000), // 1 min later
      descriptionRaw: "MERCADOPAGO COLOMBIA 003",
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
    });

    const result = await matchReceipt(userA, receiptId);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidateIds).toHaveLength(2);
      expect(result.candidateIds).toContain(tx1);
      expect(result.candidateIds).toContain(tx2);
    }
  });

  it("returns unmatched when no tx exists in the window", async () => {
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
    });

    const result = await matchReceipt(userA, receiptId);
    expect(result.status).toBe("unmatched");
  });

  it("excludes already-enriched transactions from candidates", async () => {
    // This tx already has enriched_merchant set — should be excluded.
    await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -AMOUNT,
      occurredAt: DATE,
      descriptionRaw: "MERCADOPAGO COLOMBIA 004",
      enrichedMerchant: "SomePreviousMerchant",
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
    });

    const result = await matchReceipt(userA, receiptId);
    expect(result.status).toBe("unmatched");
  });

  it("excludes soft-deleted transactions from candidates", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -AMOUNT,
      occurredAt: DATE,
      descriptionRaw: "MERCADOPAGO COLOMBIA 005",
      deletedAt: new Date(), // soft-deleted
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
    });

    const result = await matchReceipt(userA, receiptId);
    expect(result.status).toBe("unmatched");
  });

  it("throws for ingest-mode gateway (bancolombia)", async () => {
    // Bancolombia receipts should never reach the matcher — this is a
    // defense-in-depth guard in case the pull engine filter ever breaks.
    const receiptId = await db
      .insert(emailReceipts)
      .values({
        userId: userA,
        gmailConnectionId: connA,
        gmailMsgId: `${TAG}bancolombia-${Date.now()}`,
        gateway: "bancolombia",
        amountCents: AMOUNT,
        occurredAt: DATE,
        rawHtml: "<html>test</html>",
        matchStatus: "pending",
      })
      .returning({ id: emailReceipts.id })
      .then(([r]) => r.id);

    await expect(matchReceipt(userA, receiptId)).rejects.toThrow(/ingest-mode/);
  });
});
