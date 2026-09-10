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
} from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { processPendingEvidenceReceipts } from "./pull";

const TAG = "VITEST_EVIDENCE_PULL_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let accountA: number;
let connA: number;

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id = ${userA}`);
  await db.execute(sql`DELETE FROM transactions WHERE account_id = ${accountA}`);
}

beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const [user] = await db
    .insert(users)
    .values({ email: `${TAG}a@test.local`, name: `${TAG}a` })
    .returning({ id: users.id });
  userA = user.id;
  const [acct] = await db
    .insert(accounts)
    .values({
      userId: userA,
      name: `${TAG}acct`,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  accountA = acct.id;
  const [conn] = await db
    .insert(gmailConnections)
    .values({
      userId: userA,
      gmailEmail: `${TAG}${userA}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  connA = conn.id;
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
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userA}`);
  await db.execute(sql`DELETE FROM categories WHERE user_id = ${userA}`);
  await db.execute(sql`DELETE FROM accounts WHERE id = ${accountA}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userA}`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

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
      updatedAt: transactions.updatedAt,
    })
    .from(transactions)
    .where(eq(transactions.id, txId));
  return row;
}

describe("processPendingEvidenceReceipts", () => {
  it("parses merchant, links the unique same-time tx, never writes amount or reclassifies", async () => {
    const occurredAt = new Date("2026-01-05T22:42:00-05:00");
    const [tx] = await db
      .insert(transactions)
      .values({
        userId: userA,
        accountId: accountA,
        occurredAt,
        amountCents: BigInt(-15_000_000),
        currency: "COP",
        descriptionRaw: "MERCADOPAGO COLOMBIA",
        classificationMethod: "manual",
        classificationConfidence: 100,
        classificationReason: { text: "user said so" },
        categorySlug: "transporte",
        source: "sms",
      })
      .returning({ id: transactions.id });
    const before = await txClassification(tx.id);

    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId: userA,
        gmailConnectionId: connA,
        gmailMsgId: `${TAG}itin`,
        gateway: "jetsmart",
        rawHtml: `<html><body><p>Tu itinerario JetSmart</p><p>BOG → MDE</p><p>TOTAL: $85.211</p></body></html>`,
        emailReceivedAt: occurredAt,
        matchStatus: "pending",
      })
      .returning({ id: emailReceipts.id });

    await processPendingEvidenceReceipts(userA, "jetsmart");

    const [row] = await db
      .select({
        merchant: emailReceipts.merchant,
        amountCents: emailReceipts.amountCents,
        matchStatus: emailReceipts.matchStatus,
        matchedTransactionId: emailReceipts.matchedTransactionId,
        parsedAt: emailReceipts.parsedAt,
        parsedPayload: emailReceipts.parsedPayload,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receipt.id));

    expect(row.merchant).toBe("JetSmart");
    expect(row.amountCents).toBeNull();
    expect(row.matchStatus).toBe("matched");
    expect(row.matchedTransactionId).toBe(tx.id);
    expect(row.parsedAt).not.toBeNull();
    expect(row.parsedPayload).toMatchObject({
      merchant: "JetSmart",
      extra: { route: "BOG-MDE" },
    });
    expect(JSON.stringify(row.parsedPayload)).not.toContain("amountCents");
    expect(await txClassification(tx.id)).toEqual(before);
  });

  it("abstains at ingest when two txs sit inside the window", async () => {
    const occurredAt = new Date("2026-01-05T22:42:00-05:00");
    const [closer] = await db
      .insert(transactions)
      .values({
        userId: userA,
        accountId: accountA,
        occurredAt: new Date(occurredAt.getTime() + 40_000),
        amountCents: BigInt(-15_000_000),
        currency: "COP",
        descriptionRaw: `${TAG}OPE*JETSMART`,
        classificationMethod: "rule",
        source: "sms",
      })
      .returning({ id: transactions.id });
    const [farther] = await db
      .insert(transactions)
      .values({
        userId: userA,
        accountId: accountA,
        occurredAt: new Date(occurredAt.getTime() + 90_000),
        amountCents: BigInt(-8_000_000),
        currency: "COP",
        descriptionRaw: `${TAG}other`,
        classificationMethod: "rule",
        source: "sms",
      })
      .returning({ id: transactions.id });

    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId: userA,
        gmailConnectionId: connA,
        gmailMsgId: `${TAG}abstain`,
        gateway: "jetsmart",
        rawHtml: `<html><body><p>Tu itinerario JetSmart</p></body></html>`,
        emailReceivedAt: occurredAt,
        matchStatus: "pending",
      })
      .returning({ id: emailReceipts.id });

    await processPendingEvidenceReceipts(userA, "jetsmart");

    const [row] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchedTransactionId: emailReceipts.matchedTransactionId,
        parsedAt: emailReceipts.parsedAt,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receipt.id));

    expect(row.parsedAt).not.toBeNull();
    expect(row.matchStatus).toBe("unmatched");
    expect(row.matchedTransactionId).toBeNull();
    expect(row.matchedTransactionId).not.toBe(closer.id);
    expect(row.matchedTransactionId).not.toBe(farther.id);

    const inWindow = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.accountId, accountA));
    expect(inWindow.map((t) => t.id).sort()).toEqual([closer.id, farther.id].sort());
  });

  it("retries unmatched evidence once the bank tx arrives", async () => {
    const occurredAt = new Date("2026-01-05T22:42:00-05:00");
    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId: userA,
        gmailConnectionId: connA,
        gmailMsgId: `${TAG}late-tx`,
        gateway: "jetsmart",
        rawHtml: `<html><body><p>Tu itinerario JetSmart</p></body></html>`,
        emailReceivedAt: occurredAt,
        matchStatus: "pending",
      })
      .returning({ id: emailReceipts.id });

    await processPendingEvidenceReceipts(userA, "jetsmart");
    const [afterParse] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchedTransactionId: emailReceipts.matchedTransactionId,
        parsedAt: emailReceipts.parsedAt,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receipt.id));
    expect(afterParse.parsedAt).not.toBeNull();
    expect(afterParse.matchStatus).toBe("unmatched");
    expect(afterParse.matchedTransactionId).toBeNull();

    const [tx] = await db
      .insert(transactions)
      .values({
        userId: userA,
        accountId: accountA,
        occurredAt,
        amountCents: BigInt(-15_000_000),
        currency: "COP",
        descriptionRaw: "MERCADOPAGO COLOMBIA",
        classificationMethod: "ai",
        classificationConfidence: 70,
        source: "sms",
      })
      .returning({ id: transactions.id });
    const before = await txClassification(tx.id);

    await processPendingEvidenceReceipts(userA, "jetsmart");
    const [afterRetry] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchedTransactionId: emailReceipts.matchedTransactionId,
        parsedAt: emailReceipts.parsedAt,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receipt.id));

    expect(afterRetry.parsedAt).toEqual(afterParse.parsedAt);
    expect(afterRetry.matchStatus).toBe("matched");
    expect(afterRetry.matchedTransactionId).toBe(tx.id);
    expect(await txClassification(tx.id)).toEqual(before);
  });

  it("does not re-parse unmatched evidence on a second call", async () => {
    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId: userA,
        gmailConnectionId: connA,
        gmailMsgId: `${TAG}once`,
        gateway: "jetsmart",
        rawHtml: `<html><body><p>itinerario</p></body></html>`,
        emailReceivedAt: new Date("2026-01-05T22:42:00-05:00"),
        matchStatus: "pending",
      })
      .returning({ id: emailReceipts.id });

    await processPendingEvidenceReceipts(userA, "jetsmart");
    const [first] = await db
      .select({ parsedAt: emailReceipts.parsedAt })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receipt.id));

    await processPendingEvidenceReceipts(userA, "jetsmart");
    const [second] = await db
      .select({ parsedAt: emailReceipts.parsedAt, matchStatus: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receipt.id));

    expect(second.parsedAt).toEqual(first.parsedAt);
    expect(second.matchStatus).toBe("unmatched");
  });
});
