import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { upsertFxRate } from "@/lib/fx/repo";
import { convertCents } from "@/lib/money";
import {
  bogotaCalendarDay,
  correlateTransaction,
  CORRELATION_WINDOW_MS,
  fxToleranceCents,
} from "./correlate";

const TAG = "VITEST_CORRELATE_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let userB: number;
let accountA: number;
let accountB: number;
let connA: number;
let connB: number;

const EMI_TX_CENTS = BigInt(3882);
const EMI_RECEIPT_CENTS = BigInt(14_150_000);
const EMI_TRM = 3663.24;
const EMI_AS_OF = "2026-01-14";
const EMI_TX_AT = new Date("2026-01-14T19:00:00-05:00");
const EMI_EMAIL_AT = new Date("2026-01-14T19:14:17-05:00");

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM transactions WHERE account_id IN (${accountA}, ${accountB})`);
  await db.execute(sql`DELETE FROM fx_rates WHERE source = ${TAG}`);
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
  currency?: "COP" | "USD";
  descriptionRaw?: string;
  deletedAt?: Date | null;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: opts.accountId,
      occurredAt: opts.occurredAt,
      amountCents: opts.amountCents,
      currency: opts.currency ?? "COP",
      descriptionRaw: opts.descriptionRaw ?? `${TAG}MERCADOPAGO COLOMBIA`,
      classificationMethod: "unclassified",
      source: "sms",
      deletedAt: opts.deletedAt ?? null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function createReceipt(opts: {
  userId: number;
  connId: number;
  amountCents: bigint;
  currency: "COP" | "USD";
  emailReceivedAt: Date | null;
  occurredAt?: Date | null;
  createdAt?: Date;
  merchant?: string;
  msgId?: string;
}): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId: opts.userId,
      gmailConnectionId: opts.connId,
      gmailMsgId: opts.msgId ?? `${TAG}${Date.now()}-${Math.random()}`,
      gateway: "mercado_pago",
      amountCents: opts.amountCents,
      currency: opts.currency,
      occurredAt: opts.occurredAt ?? opts.emailReceivedAt,
      emailReceivedAt: opts.emailReceivedAt,
      createdAt: opts.createdAt,
      merchant: opts.merchant ?? "TestMerchant",
      rawHtml: "<html>test</html>",
      matchStatus: "unmatched",
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
  await cleanup();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM accounts WHERE id IN (${accountA}, ${accountB})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

describe("correlateTransaction — EMI cross-currency", () => {
  it("matches COP receipt to USD tx using TRM on the tx Bogota date", async () => {
    expect(bogotaCalendarDay(EMI_TX_AT)).toBe(EMI_AS_OF);
    expect(EMI_TX_AT.toISOString().slice(0, 10)).toBe("2026-01-15");

    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: EMI_TRM,
      asOf: EMI_AS_OF,
      source: TAG,
    });
    await upsertFxRate({
      base: "USD",
      quote: "COP",
      rate: 9999,
      asOf: "2026-01-15",
      source: TAG,
    });

    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -EMI_TX_CENTS,
      currency: "USD",
      occurredAt: EMI_TX_AT,
      descriptionRaw: "ARQ purchase: MERCPAGO*PASARELAEMI",
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      amountCents: EMI_RECEIPT_CENTS,
      currency: "COP",
      emailReceivedAt: EMI_EMAIL_AT,
      merchant: "EMPRESA DE MEDICINA INTEGRAL EMI S.A.S.",
    });

    const converted = convertCents(EMI_RECEIPT_CENTS, "COP", "USD", EMI_TRM);
    const expectedDelta = EMI_TX_CENTS - converted;
    expect(expectedDelta).toBe(BigInt(20));
    expect(expectedDelta <= fxToleranceCents(EMI_TX_CENTS)).toBe(true);

    const result = await correlateTransaction(userA, txId);
    expect(result).not.toHaveProperty("status");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      receiptId,
      rank: 1,
    });
    expect(result.candidates[0].reason).toEqual({
      kind: "cross_currency",
      rateAsOf: EMI_AS_OF,
      rate: EMI_TRM,
      deltaCents: expectedDelta,
      deltaMs: EMI_EMAIL_AT.getTime() - EMI_TX_AT.getTime(),
    });
  });
});

describe("correlateTransaction — exact same-currency", () => {
  it("returns a one-element ranked set with a reason, never a bare matched status", async () => {
    const occurredAt = new Date("2026-01-26T00:15:35-05:00");
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: BigInt(-8_521_100),
      currency: "COP",
      occurredAt,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      amountCents: BigInt(8_521_100),
      currency: "COP",
      emailReceivedAt: new Date("2026-01-26T00:16:10-05:00"),
    });

    const result = await correlateTransaction(userA, txId);
    expect(result).not.toHaveProperty("status");
    expect(result.candidates).toEqual([
      {
        receiptId,
        rank: 1,
        reason: {
          kind: "exact_amount",
          deltaCents: BigInt(0),
          deltaMs: 35_000,
        },
      },
    ]);
  });
});

describe("correlateTransaction — two-way ambiguity", () => {
  it("returns both equally-plausible receipts ranked by time proximity", async () => {
    const occurredAt = new Date("2026-03-26T11:25:49-05:00");
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: BigInt(-28_804_000),
      currency: "COP",
      occurredAt,
    });
    const closer = await createReceipt({
      userId: userA,
      connId: connA,
      amountCents: BigInt(28_804_000),
      currency: "COP",
      emailReceivedAt: new Date("2026-03-26T11:26:10-05:00"),
      msgId: `${TAG}closer`,
    });
    const farther = await createReceipt({
      userId: userA,
      connId: connA,
      amountCents: BigInt(28_804_000),
      currency: "COP",
      emailReceivedAt: new Date("2026-03-26T12:00:00-05:00"),
      msgId: `${TAG}farther`,
    });

    const result = await correlateTransaction(userA, txId);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ receiptId: closer, rank: 1 });
    expect(result.candidates[1]).toMatchObject({ receiptId: farther, rank: 2 });
    expect(result.candidates.every((c) => c.reason.kind === "exact_amount")).toBe(true);
  });
});

describe("correlateTransaction — tenant isolation", () => {
  it("does not return another user's receipt even when amount and time match", async () => {
    const occurredAt = new Date("2026-04-19T11:53:41-05:00");
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: BigInt(-6_599_000),
      currency: "COP",
      occurredAt,
    });
    await createReceipt({
      userId: userB,
      connId: connB,
      amountCents: BigInt(6_599_000),
      currency: "COP",
      emailReceivedAt: occurredAt,
    });

    const result = await correlateTransaction(userA, txId);
    expect(result.candidates).toEqual([]);
  });

  it("throws when the transaction does not belong to the caller", async () => {
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: BigInt(-1000),
      occurredAt: new Date("2026-04-19T11:53:41-05:00"),
    });
    await expect(correlateTransaction(userB, txId)).rejects.toThrow(/not found/);
  });
});

describe("correlateTransaction — missing rate", () => {
  it("returns no cross-currency candidate when no covering TRM exists", async () => {
    const occurredAt = new Date("1980-06-15T12:00:00-05:00");
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: -EMI_TX_CENTS,
      currency: "USD",
      occurredAt,
    });
    await createReceipt({
      userId: userA,
      connId: connA,
      amountCents: EMI_RECEIPT_CENTS,
      currency: "COP",
      emailReceivedAt: new Date("1980-06-15T12:10:00-05:00"),
    });

    const result = await correlateTransaction(userA, txId);
    expect(result.candidates).toEqual([]);
  });
});

describe("correlateTransaction — email_received_at gotchas", () => {
  it("does not fall back to createdAt when email_received_at is null", async () => {
    const occurredAt = new Date("2026-01-26T00:15:35-05:00");
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: BigInt(-8_521_100),
      currency: "COP",
      occurredAt,
    });
    await createReceipt({
      userId: userA,
      connId: connA,
      amountCents: BigInt(8_521_100),
      currency: "COP",
      emailReceivedAt: null,
      createdAt: occurredAt,
    });

    const result = await correlateTransaction(userA, txId);
    expect(result.candidates).toEqual([]);
  });

  it("does not match a receipt outside the 36h window", async () => {
    const occurredAt = new Date("2026-01-26T00:15:35-05:00");
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      amountCents: BigInt(-8_521_100),
      currency: "COP",
      occurredAt,
    });
    await createReceipt({
      userId: userA,
      connId: connA,
      amountCents: BigInt(8_521_100),
      currency: "COP",
      emailReceivedAt: new Date(occurredAt.getTime() + CORRELATION_WINDOW_MS + 1_000),
    });

    const result = await correlateTransaction(userA, txId);
    expect(result.candidates).toEqual([]);
  });
});
