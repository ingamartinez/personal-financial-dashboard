import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
import type { ParsedBancolombiaTx, BancolombiaParseResult } from "./bancolombia-variants";
import { ingestParsedEmail } from "./email-bancolombia";

const MARKER = "__email_bancolombia_test";
const COP_TZ_OFFSET = "-05:00";

let USER_A = 0;
let USER_B = 0;
let CONN_A = 0;

async function cleanup() {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM transactions WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM accounts WHERE user_id IN (${USER_A}, ${USER_B})`);
}

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ email: `${MARKER}-a@test.local`, name: "A" })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: `${MARKER}-b@test.local`, name: "B" })
    .returning({ id: users.id });
  USER_A = a.id;
  USER_B = b.id;

  // Gmail connections — email_receipts FK-depends on them. Tokens are
  // dummy ciphertext; nothing in this suite hits Google.
  const [connA] = await db
    .insert(gmailConnections)
    .values({
      userId: USER_A,
      gmailEmail: `${MARKER}-a@test.local`,
      accessTokenEnc: "dummy",
      refreshTokenEnc: "dummy",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  // USER_B has no gmail connection — they exist only to assert cross-tenant
  // isolation on the dedup query (no emails ingested on their side).
  CONN_A = connA.id;
});

beforeEach(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`);
});

// -----------------------------------------------------------------------------
// Seed helpers
// -----------------------------------------------------------------------------

async function seedSavings(userId: number, last4: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${MARKER} savings ${last4}`,
      institution: "Bancolombia",
      type: "savings",
      currency: "COP",
      metadata: { last4s: [last4] },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedCreditCard(userId: number, last4: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${MARKER} tc ${last4}`,
      institution: "Bancolombia",
      type: "credit_card",
      currency: "COP",
      metadata: { last4s: [last4], creditLimitCents: 10_000_000 },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedReceipt(userId: number, connId: number, msgId: string): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: msgId,
      gateway: "bancolombia",
      rawHtml: "<html><body>test</body></html>",
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

async function insertExistingTx(params: {
  userId: number;
  accountId: number;
  amountCents: bigint;
  occurredAt: Date;
  merchant: string;
  source: "sms" | "gmail_bancolombia" | "csv";
  kind: string;
  externalId: string;
  smsBody?: string;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: params.userId,
      accountId: params.accountId,
      occurredAt: params.occurredAt,
      amountCents: params.amountCents,
      currency: "COP",
      descriptionRaw: params.merchant,
      merchant: params.merchant,
      classificationMethod: "unclassified",
      source: params.source,
      externalId: params.externalId,
      rawData: { kind: params.kind, sms: params.smsBody ?? params.merchant },
    })
    .returning({ id: transactions.id });
  return row.id;
}

function buildPurchaseParsed(overrides?: Partial<ParsedBancolombiaTx>): BancolombiaParseResult {
  return {
    kind: "purchase",
    amountCents: BigInt(4424700),
    currency: "COP",
    merchant: "MERCADOPAGO COLOMBIA",
    cardLast4: "2575",
    cardKind: "credit",
    occurredOn: "2026-04-08",
    occurredTime: "17:38",
    externalId: "bcol-email:abc123",
    raw: "Bancolombia: Compraste COP44.247,00 en MERCADOPAGO COLOMBIA con tu T.Cred *2575, el 08/04/2026 a las 17:38.",
    ...overrides,
  } as ParsedBancolombiaTx;
}

function parsedOccurredAt(p: ParsedBancolombiaTx): Date {
  if (!("occurredOn" in p)) throw new Error("parsedOccurredAt: kind has no occurredOn");
  return new Date(`${p.occurredOn}T${p.occurredTime}:00${COP_TZ_OFFSET}`);
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

describe("ingestParsedEmail — fresh insert (no existing match)", () => {
  it("inserts a new tx with source='gmail_bancolombia'", async () => {
    const accountId = await seedCreditCard(USER_A, "2575");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-fresh-1");
    const parsed = buildPurchaseParsed();

    const result = await ingestParsedEmail(USER_A, parsed, receiptId);
    expect(result.status).toBe("inserted");

    if (result.status !== "inserted") throw new Error("expected inserted");
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, result.txId));
    expect(tx.source).toBe("gmail_bancolombia");
    expect(tx.accountId).toBe(accountId);
    expect(tx.amountCents).toBe(BigInt(-4424700)); // purchases are stored negative
    expect(tx.merchant).toBe("MERCADOPAGO COLOMBIA");
    expect((tx.rawData as { email_receipt_id?: number }).email_receipt_id).toBe(receiptId);

    const [receipt] = await db.select().from(emailReceipts).where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchStatus).toBe("matched");
    expect(receipt.matchedTransactionId).toBe(result.txId);
    expect(receipt.parsedPayload).toBeTruthy();
    expect(receipt.amountCents).toBe(BigInt(4424700));
  });
});

describe("ingestParsedEmail — A+ dedup against existing tx", () => {
  it("preserves existing SMS tx and marks receipt matched (no diffs)", async () => {
    const accountId = await seedCreditCard(USER_A, "2575");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-dedup-agreement");

    const parsed = buildPurchaseParsed();
    const existingTxId = await insertExistingTx({
      userId: USER_A,
      accountId,
      amountCents: BigInt(-4424700),
      occurredAt: parsedOccurredAt(parsed as ParsedBancolombiaTx),
      merchant: "MERCADOPAGO COLOMBIA",
      source: "sms",
      kind: "purchase",
      externalId: "bcol-sms:existing",
    });

    const result = await ingestParsedEmail(USER_A, parsed, receiptId);
    expect(result.status).toBe("duplicated");

    // Existing tx unchanged
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, existingTxId));
    expect(tx.source).toBe("sms"); // preserved
    expect(tx.sourceMismatch).toBe(false); // no diffs

    // Receipt marked matched to existing tx
    const [receipt] = await db.select().from(emailReceipts).where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchStatus).toBe("matched");
    expect(receipt.matchedTransactionId).toBe(existingTxId);

    // No new tx was created
    const count = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM transactions WHERE user_id = ${USER_A}`,
    );
    expect(count[0].c).toBe(1);
  });

  it("flags source_mismatch when email disagrees on merchant", async () => {
    const accountId = await seedCreditCard(USER_A, "2575");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-dedup-merchant-diff");

    const parsed = buildPurchaseParsed();
    const existingTxId = await insertExistingTx({
      userId: USER_A,
      accountId,
      amountCents: BigInt(-4424700),
      occurredAt: parsedOccurredAt(parsed as ParsedBancolombiaTx),
      merchant: "MERCADOPAGO CO", // truncated by SMS parser
      source: "sms",
      kind: "purchase",
      externalId: "bcol-sms:existing-2",
    });

    const result = await ingestParsedEmail(USER_A, parsed, receiptId);
    expect(result.status).toBe("duplicated");

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, existingTxId));
    expect(tx.sourceMismatch).toBe(true);
    expect(tx.sourceMismatchDetails).toBeTruthy();
    const details = tx.sourceMismatchDetails as {
      fromSource: string;
      toSource: string;
      diffs: Array<{ field: string; fromValue: unknown; toValue: unknown }>;
    };
    expect(details.fromSource).toBe("sms");
    expect(details.toSource).toBe("gmail_bancolombia");
    const merchantDiff = details.diffs.find((d) => d.field === "merchant");
    expect(merchantDiff).toBeTruthy();
    expect(merchantDiff?.fromValue).toBe("MERCADOPAGO CO");
    expect(merchantDiff?.toValue).toBe("MERCADOPAGO COLOMBIA");
  });

  it("flags source_mismatch when occurredAt skew exceeds 1 minute", async () => {
    const accountId = await seedCreditCard(USER_A, "2575");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-dedup-time-skew");

    const parsed = buildPurchaseParsed();
    const parsedTime = parsedOccurredAt(parsed as ParsedBancolombiaTx);
    // SMS arrived ~3 minutes before the email said (within 5-min dedup window)
    const smsTime = new Date(parsedTime.getTime() - 3 * 60 * 1000);
    const existingTxId = await insertExistingTx({
      userId: USER_A,
      accountId,
      amountCents: BigInt(-4424700),
      occurredAt: smsTime,
      merchant: "MERCADOPAGO COLOMBIA",
      source: "sms",
      kind: "purchase",
      externalId: "bcol-sms:existing-3",
    });

    const result = await ingestParsedEmail(USER_A, parsed, receiptId);
    expect(result.status).toBe("duplicated");

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, existingTxId));
    expect(tx.sourceMismatch).toBe(true);
    const details = tx.sourceMismatchDetails as {
      diffs: Array<{ field: string }>;
    };
    expect(details.diffs.some((d) => d.field === "occurredAt")).toBe(true);
  });
});

describe("ingestParsedEmail — cross-tenant isolation", () => {
  it("does not match user B's tx when user A's email arrives", async () => {
    // User B has a tx that would match on amount+date+kind
    const accountB = await seedCreditCard(USER_B, "2575");
    const parsed = buildPurchaseParsed();
    await insertExistingTx({
      userId: USER_B,
      accountId: accountB,
      amountCents: BigInt(-4424700),
      occurredAt: parsedOccurredAt(parsed as ParsedBancolombiaTx),
      merchant: "MERCADOPAGO COLOMBIA",
      source: "sms",
      kind: "purchase",
      externalId: "bcol-sms:user-b",
    });

    // User A sees the same purchase pattern on their own credit card
    const accountA = await seedCreditCard(USER_A, "2575");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-cross-tenant");

    const result = await ingestParsedEmail(USER_A, parsed, receiptId);
    expect(result.status).toBe("inserted"); // new tx for A, NOT matched to B's tx

    // User B's tx untouched
    const [txB] = await db.select().from(transactions).where(eq(transactions.userId, USER_B));
    expect(txB.sourceMismatch).toBe(false);
    expect(txB.accountId).toBe(accountB);

    // User A got a new tx on their own account
    if (result.status !== "inserted") throw new Error("expected inserted");
    const [txA] = await db.select().from(transactions).where(eq(transactions.id, result.txId));
    expect(txA.userId).toBe(USER_A);
    expect(txA.accountId).toBe(accountA);
    expect(txA.source).toBe("gmail_bancolombia");
  });
});

describe("ingestParsedEmail — skip and needs_review handling", () => {
  it("marks receipt unmatched on parser skip", async () => {
    await seedCreditCard(USER_A, "2575");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-skip");

    const result = await ingestParsedEmail(
      USER_A,
      { kind: "skip", reason: "statement_notification", raw: "Toc-toc..." },
      receiptId,
    );
    expect(result.status).toBe("skipped");

    const [receipt] = await db.select().from(emailReceipts).where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchStatus).toBe("unmatched");
    expect(receipt.matchedTransactionId).toBeNull();
  });

  it("returns error on needs_review without modifying receipt status", async () => {
    await seedCreditCard(USER_A, "2575");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-needs-review");

    const result = await ingestParsedEmail(
      USER_A,
      { kind: "needs_review", reason: "unknown_pattern", raw: "weird text" },
      receiptId,
    );
    expect(result.status).toBe("error");

    // Receipt stays pending so a future parser rev can retry
    const [receipt] = await db.select().from(emailReceipts).where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchStatus).toBe("pending");
  });
});

describe("ingestParsedEmail — account routing failures", () => {
  it("returns error when no account matches the parsed last4", async () => {
    // Seed a different last4 — parser expects *2575, account is *9999
    await seedCreditCard(USER_A, "9999");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-no-account");
    const parsed = buildPurchaseParsed(); // cardLast4 = "2575"

    const result = await ingestParsedEmail(USER_A, parsed, receiptId);
    expect(result.status).toBe("error");

    // Receipt stays pending — user might add the card later and a retry will resolve it
    const [receipt] = await db.select().from(emailReceipts).where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchStatus).toBe("pending");

    // No tx created
    const count = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM transactions WHERE user_id = ${USER_A}`,
    );
    expect(count[0].c).toBe(0);
  });
});

describe("ingestParsedEmail — kind-aware dedup", () => {
  it("prefers same-kind match when multiple candidates share amount+time window", async () => {
    const accountId = await seedSavings(USER_A, "6126");
    const receiptId = await seedReceipt(USER_A, CONN_A, "msg-kind-preferred");

    // Two existing txs within window: one kind=transfer_sent (adversarial),
    // one kind=transfer_received (the real match).
    const occurredAt = new Date("2026-04-10T10:00:00-05:00");
    await insertExistingTx({
      userId: USER_A,
      accountId,
      amountCents: BigInt(5000000), // positive
      occurredAt: new Date(occurredAt.getTime() - 60 * 1000),
      merchant: "ALICE",
      source: "csv",
      kind: "transfer_sent",
      externalId: "csv:wrong-kind",
    });
    const realMatchId = await insertExistingTx({
      userId: USER_A,
      accountId,
      amountCents: BigInt(5000000),
      occurredAt,
      merchant: "MARIA PAZ",
      source: "sms",
      kind: "transfer_received",
      externalId: "bcol-sms:right-kind",
    });

    const parsed: BancolombiaParseResult = {
      kind: "transfer_received",
      amountCents: BigInt(5000000),
      currency: "COP",
      senderName: "MARIA PAZ",
      toLast4: "6126",
      occurredOn: "2026-04-10",
      occurredTime: "10:00",
      externalId: "bcol-email:right-kind",
      raw: "Bancolombia: Recibiste...",
    };

    const result = await ingestParsedEmail(USER_A, parsed, receiptId);
    expect(result.status).toBe("duplicated");

    const [receipt] = await db.select().from(emailReceipts).where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchedTransactionId).toBe(realMatchId);
  });
});
