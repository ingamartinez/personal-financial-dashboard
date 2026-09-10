import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  emailReceipts,
  gmailConnections,
  transactions,
  users,
  type ParsedReceiptError,
  type ParsedReceiptPayload,
} from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { EVIDENCE_TIME_ONLY_WINDOW_MS } from "./correlate";
import {
  backfillUnmatchedEvidenceReceipts,
  countUnmatchedEvidenceReceipts,
  findEvidenceTxCandidates,
  linkEvidenceReceipt,
} from "./link-evidence";

const TAG = "VITEST_EVIDENCE_LINK_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let userB: number;
let accountA: number;
let accountB: number;
let connA: number;

const RECEIPT_AT = new Date("2026-01-05T22:42:00-05:00");

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
  occurredAt: Date;
  descriptionRaw?: string;
  classificationMethod?: "rule" | "ai" | "manual" | "unclassified";
  classificationConfidence?: number | null;
  classificationReason?: { text: string };
  categorySlug?: string | null;
  deletedAt?: Date | null;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: opts.accountId,
      occurredAt: opts.occurredAt,
      amountCents: BigInt(-15_000_000),
      currency: "COP",
      descriptionRaw: opts.descriptionRaw ?? `${TAG}MERCADOPAGO COLOMBIA`,
      classificationMethod: opts.classificationMethod ?? "unclassified",
      classificationConfidence: opts.classificationConfidence ?? null,
      classificationReason: opts.classificationReason ?? null,
      categorySlug: opts.categorySlug ?? null,
      source: "sms",
      deletedAt: opts.deletedAt ?? null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function createReceipt(opts: {
  userId: number;
  connId: number;
  emailReceivedAt: Date | null;
  amountCents?: bigint | null;
  currency?: "COP" | null;
  gateway?: "jetsmart" | "mercado_pago";
  matchStatus?: "pending" | "matched" | "unmatched";
  matchedTransactionId?: number | null;
  parsedAt?: Date | null;
  parsedPayload?: ParsedReceiptPayload | ParsedReceiptError;
  msgId?: string;
}): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId: opts.userId,
      gmailConnectionId: opts.connId,
      gmailMsgId: opts.msgId ?? `${TAG}${Date.now()}-${Math.random()}`,
      gateway: opts.gateway ?? "jetsmart",
      amountCents: opts.amountCents ?? null,
      currency: opts.currency ?? null,
      emailReceivedAt: opts.emailReceivedAt,
      merchant: "JetSmart",
      rawHtml: "<html>itinerario</html>",
      matchStatus: opts.matchStatus ?? "unmatched",
      matchedTransactionId: opts.matchedTransactionId ?? null,
      parsedAt: opts.parsedAt ?? new Date(),
      parsedPayload: opts.parsedPayload ?? { merchant: "JetSmart" },
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

async function txClassification(txId: number) {
  const [row] = await db
    .select({
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      classificationConfidence: transactions.classificationConfidence,
      classificationReason: transactions.classificationReason,
      enrichedMerchant: transactions.enrichedMerchant,
      enrichmentSource: transactions.enrichmentSource,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
      updatedAt: transactions.updatedAt,
    })
    .from(transactions)
    .where(eq(transactions.id, txId));
  return row;
}

async function receiptMatch(receiptId: number) {
  const [row] = await db
    .select({
      matchStatus: emailReceipts.matchStatus,
      matchedTransactionId: emailReceipts.matchedTransactionId,
    })
    .from(emailReceipts)
    .where(eq(emailReceipts.id, receiptId));
  return row;
}

beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  userA = await createUser("A");
  userB = await createUser("B");
  accountA = await createAccount(userA, "A");
  accountB = await createAccount(userB, "B");
  connA = await createConnection(userA);
  await db.insert(categories).values({
    userId: userA,
    slug: "transporte",
    name: "Transporte",
    icon: "bus",
    color: "#0ea5e9",
    sortOrder: 1,
  });
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM categories WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM accounts WHERE id IN (${accountA}, ${accountB})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

describe("findEvidenceTxCandidates / linkEvidenceReceipt", () => {
  it("links a unique in-window tx (prod 2253 / 2s shape) without touching the tx row", async () => {
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 2_000),
      classificationMethod: "manual",
      classificationConfidence: 100,
      classificationReason: { text: "user said so" },
      categorySlug: "transporte",
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });
    const before = await txClassification(txId);

    const result = await linkEvidenceReceipt(userA, receiptId);

    expect(result).toEqual({ status: "matched", transactionId: txId });
    expect(await receiptMatch(receiptId)).toEqual({
      matchStatus: "matched",
      matchedTransactionId: txId,
    });
    expect(await txClassification(txId)).toEqual(before);
  });

  it("abstains when two txs sit inside the window — seeding only one candidate would hide a nearest-neighbor bug", async () => {
    const closerId = await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 40_000),
      descriptionRaw: `${TAG}OPE*JETSMART`,
    });
    const fartherId = await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 90_000),
      descriptionRaw: `${TAG}unrelated`,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });

    const candidates = await findEvidenceTxCandidates(userA, receiptId);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.txId).sort()).toEqual([closerId, fartherId].sort());
    expect(Math.abs(candidates[0]!.deltaMs)).toBeLessThan(Math.abs(candidates[1]!.deltaMs));
    expect(candidates[0]!.txId).toBe(closerId);

    const result = await linkEvidenceReceipt(userA, receiptId);
    expect(result.status).toBe("abstained");
    if (result.status !== "abstained") throw new Error("expected abstained");
    expect(result.candidateIds.sort()).toEqual([closerId, fartherId].sort());

    const row = await receiptMatch(receiptId);
    expect(row.matchStatus).toBe("unmatched");
    expect(row.matchedTransactionId).toBeNull();
    expect(row.matchedTransactionId).not.toBe(closerId);
  });

  it("unique-matches 40s when the 220s decoy is outside the window (prod 2220)", async () => {
    const insideId = await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 40_000),
      descriptionRaw: `${TAG}OPE*JETSMART`,
    });
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 220_000),
      descriptionRaw: `${TAG}decoy`,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });

    const candidates = await findEvidenceTxCandidates(userA, receiptId);
    expect(candidates).toEqual([{ txId: insideId, deltaMs: 40_000 }]);

    const result = await linkEvidenceReceipt(userA, receiptId);
    expect(result).toEqual({ status: "matched", transactionId: insideId });
  });

  it("does not match a lone tx 220s away (window is 2 min, not 5 min or 7 days)", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 220_000),
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([]);
    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({ status: "unmatched" });
    expect(await receiptMatch(receiptId)).toEqual({
      matchStatus: "unmatched",
      matchedTransactionId: null,
    });
  });

  it("does not match a tx just outside EVIDENCE_TIME_ONLY_WINDOW_MS", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + EVIDENCE_TIME_ONLY_WINDOW_MS + 1_000),
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([]);
    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({ status: "unmatched" });
  });

  it("does not time-only match an amount-bearing evidence receipt", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
      amountCents: BigInt(8_521_100),
      currency: "COP",
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([]);
    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({ status: "unmatched" });
  });

  it("does not time-only match an amount-less enrich receipt", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
      gateway: "mercado_pago",
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([]);
  });

  it("does not correlate a skipped/error payload receipt even with a unique in-window tx", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
      parsedPayload: { error: { reason: "not_an_itinerary", kind: "skipped" } },
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([]);
    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({ status: "unmatched" });
  });

  it("ignores another tenant's in-window tx", async () => {
    const ownId = await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
    });
    await createTx({
      userId: userB,
      accountId: accountB,
      occurredAt: RECEIPT_AT,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([{ txId: ownId, deltaMs: 0 }]);
    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({
      status: "matched",
      transactionId: ownId,
    });
  });

  it("throws on a cross-tenant receipt id rather than linking", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });

    await expect(linkEvidenceReceipt(userB, receiptId)).rejects.toThrow(/not found/);
    expect(await receiptMatch(receiptId)).toEqual({
      matchStatus: "unmatched",
      matchedTransactionId: null,
    });
  });

  it("does not unmatch an already-linked receipt when a second tx appears later", async () => {
    const firstId = await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 2_000),
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });
    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({
      status: "matched",
      transactionId: firstId,
    });

    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 10_000),
    });

    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({
      status: "matched",
      transactionId: firstId,
    });
    expect(await receiptMatch(receiptId)).toEqual({
      matchStatus: "matched",
      matchedTransactionId: firstId,
    });
  });

  it("skips a soft-deleted in-window tx", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
      deletedAt: new Date(),
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([]);
  });

  it("returns unmatched when emailReceivedAt is null (createdAt is not event time)", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: null,
    });

    expect(await findEvidenceTxCandidates(userA, receiptId)).toEqual([]);
    expect(await linkEvidenceReceipt(userA, receiptId)).toEqual({ status: "unmatched" });
  });
});

describe("backfillUnmatchedEvidenceReceipts", () => {
  it("matches unmatched evidence and is a no-op on the second run", async () => {
    const txId = await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: new Date(RECEIPT_AT.getTime() + 5_000),
      classificationMethod: "rule",
      classificationConfidence: 90,
      categorySlug: "transporte",
    });
    const receiptId = await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
      matchStatus: "unmatched",
    });
    const before = await txClassification(txId);

    expect(await countUnmatchedEvidenceReceipts({ userId: userA })).toBe(1);

    const first = await backfillUnmatchedEvidenceReceipts({ userId: userA });
    expect(first).toEqual({ considered: 1, matched: 1, abstained: 0, unmatched: 0 });
    expect(await receiptMatch(receiptId)).toEqual({
      matchStatus: "matched",
      matchedTransactionId: txId,
    });
    expect(await txClassification(txId)).toEqual(before);

    expect(await countUnmatchedEvidenceReceipts({ userId: userA })).toBe(0);
    const second = await backfillUnmatchedEvidenceReceipts({ userId: userA });
    expect(second).toEqual({ considered: 0, matched: 0, abstained: 0, unmatched: 0 });
    expect(await receiptMatch(receiptId)).toEqual({
      matchStatus: "matched",
      matchedTransactionId: txId,
    });
    expect(await txClassification(txId)).toEqual(before);
  });

  it("does not backfill a skipped error-payload receipt", async () => {
    await createTx({
      userId: userA,
      accountId: accountA,
      occurredAt: RECEIPT_AT,
    });
    await createReceipt({
      userId: userA,
      connId: connA,
      emailReceivedAt: RECEIPT_AT,
      parsedPayload: { error: { reason: "not_an_itinerary", kind: "skipped" } },
    });

    expect(await countUnmatchedEvidenceReceipts({ userId: userA })).toBe(0);
    expect(await backfillUnmatchedEvidenceReceipts({ userId: userA })).toEqual({
      considered: 0,
      matched: 0,
      abstained: 0,
      unmatched: 0,
    });
  });
});
