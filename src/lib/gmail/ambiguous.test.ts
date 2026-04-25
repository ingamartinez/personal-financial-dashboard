import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { loadAmbiguousReceiptsForTxIds } from "./ambiguous";

const TAG = "VITEST_AMBIGUOUS_";
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

async function createTx(
  userId: number,
  accountId: number,
  desc = "MERCHANT TEST",
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-01T10:00:00Z"),
      amountCents: BigInt(-50000),
      currency: "COP",
      descriptionRaw: desc,
      classificationMethod: "unclassified",
      source: "sms",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function createAmbiguousReceipt(opts: {
  userId: number;
  connId: number;
  candidates: number[];
  merchant?: string;
}): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId: opts.userId,
      gmailConnectionId: opts.connId,
      gmailMsgId: `${TAG}${Date.now()}-${Math.random()}`,
      gateway: "mercado_pago",
      amountCents: BigInt(50000),
      occurredAt: new Date("2026-04-01T10:30:00Z"),
      merchant: opts.merchant ?? "TestMerchant",
      currency: "COP",
      rawHtml: "<html>test receipt</html>",
      matchStatus: "ambiguous",
      matchCandidates: opts.candidates,
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

describe("loadAmbiguousReceiptsForTxIds", () => {
  it("returns empty map when txIds is empty", async () => {
    const result = await loadAmbiguousReceiptsForTxIds(userA, []);
    expect(result.size).toBe(0);
  });

  it("returns receipts for tx_ids belonging to the requesting user", async () => {
    const txId = await createTx(userA, accountA);
    await createAmbiguousReceipt({ userId: userA, connId: connA, candidates: [txId] });

    const result = await loadAmbiguousReceiptsForTxIds(userA, [txId]);

    expect(result.size).toBe(1);
    const receipts = result.get(txId);
    expect(receipts).toBeDefined();
    expect(receipts!.length).toBe(1);
    expect(receipts![0].gateway).toBe("mercado_pago");
    expect(receipts![0].merchant).toBe("TestMerchant");
    expect(receipts![0].amountCents).toBe("50000");
  });

  it("does NOT return receipts belonging to a different user (tenant isolation)", async () => {
    // userB has a tx and a receipt pointing at it
    const txIdB = await createTx(userB, accountB);
    await createAmbiguousReceipt({ userId: userB, connId: connB, candidates: [txIdB] });

    // userA queries with userB's tx_id — should get nothing
    const result = await loadAmbiguousReceiptsForTxIds(userA, [txIdB]);
    expect(result.size).toBe(0);
  });

  it("does NOT surface cross-tenant tx_ids in receipt candidates", async () => {
    // userA has a tx. userB has a receipt that (maliciously) lists userA's tx_id.
    const txIdA = await createTx(userA, accountA);
    await createAmbiguousReceipt({ userId: userB, connId: connB, candidates: [txIdA] });

    // userA queries — the receipt belongs to userB and must NOT be returned
    const result = await loadAmbiguousReceiptsForTxIds(userA, [txIdA]);
    expect(result.size).toBe(0);
  });

  it("one receipt can match multiple tx_ids on the same page", async () => {
    const tx1 = await createTx(userA, accountA, "MERCHANT A");
    const tx2 = await createTx(userA, accountA, "MERCHANT B");
    await createAmbiguousReceipt({ userId: userA, connId: connA, candidates: [tx1, tx2] });

    const result = await loadAmbiguousReceiptsForTxIds(userA, [tx1, tx2]);

    expect(result.get(tx1)?.length).toBe(1);
    expect(result.get(tx2)?.length).toBe(1);
    // Same receipt id appears on both entries
    expect(result.get(tx1)![0].id).toBe(result.get(tx2)![0].id);
  });

  it("multiple receipts can reference the same tx (ambiguous scenario)", async () => {
    const txId = await createTx(userA, accountA);
    await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txId],
      merchant: "Merchant 1",
    });
    await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txId],
      merchant: "Merchant 2",
    });

    const result = await loadAmbiguousReceiptsForTxIds(userA, [txId]);

    const receipts = result.get(txId);
    expect(receipts?.length).toBe(2);
    const merchants = receipts!.map((r) => r.merchant).sort();
    expect(merchants).toEqual(["Merchant 1", "Merchant 2"]);
  });

  it("skips non-ambiguous receipts (matched, pending, unmatched)", async () => {
    const txId = await createTx(userA, accountA);

    // Insert a matched receipt that also references this tx_id (edge case)
    await db.insert(emailReceipts).values({
      userId: userA,
      gmailConnectionId: connA,
      gmailMsgId: `${TAG}matched-${Date.now()}`,
      gateway: "payu",
      amountCents: BigInt(50000),
      occurredAt: new Date("2026-04-01T10:30:00Z"),
      merchant: "ShouldNotAppear",
      currency: "COP",
      rawHtml: "<html>matched</html>",
      matchStatus: "matched",
      matchCandidates: [txId],
    });

    const result = await loadAmbiguousReceiptsForTxIds(userA, [txId]);
    expect(result.size).toBe(0);
  });

  it("skips soft-deleted receipts", async () => {
    const txId = await createTx(userA, accountA);
    const receiptId = await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txId],
    });

    // Soft-delete the receipt
    await db.execute(sql`UPDATE email_receipts SET deleted_at = NOW() WHERE id = ${receiptId}`);

    const result = await loadAmbiguousReceiptsForTxIds(userA, [txId]);
    expect(result.size).toBe(0);
  });

  it("only attaches receipts for tx_ids in the visible set (page boundary safety)", async () => {
    const txOnPage = await createTx(userA, accountA, "ON PAGE");
    const txOffPage = await createTx(userA, accountA, "OFF PAGE");

    // Receipt references both, but we only query for txOnPage
    await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txOnPage, txOffPage],
    });

    const result = await loadAmbiguousReceiptsForTxIds(userA, [txOnPage]);
    expect(result.has(txOnPage)).toBe(true);
    // txOffPage was not in the query's tx_ids — the filter strips it
    expect(result.has(txOffPage)).toBe(false);
  });
});
