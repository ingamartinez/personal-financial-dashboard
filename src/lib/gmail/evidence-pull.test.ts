import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
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
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${userA}`);
  await db.execute(sql`DELETE FROM accounts WHERE id = ${accountA}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userA}`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

describe("processPendingEvidenceReceipts", () => {
  it("parses merchant, never matches a bank tx, never writes amount from a fare", async () => {
    const occurredAt = new Date("2026-01-05T22:42:00-05:00");
    const [tx] = await db
      .insert(transactions)
      .values({
        userId: userA,
        accountId: accountA,
        occurredAt,
        amountCents: BigInt(-15_000_000),
        currency: "COP",
        descriptionRaw: "COMPRA JETSMART",
        classificationMethod: "unclassified",
        source: "sms",
      })
      .returning({ id: transactions.id });

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
    expect(row.matchStatus).toBe("unmatched");
    expect(row.matchedTransactionId).toBeNull();
    expect(row.parsedAt).not.toBeNull();
    expect(row.parsedPayload).toMatchObject({
      merchant: "JetSmart",
      extra: { route: "BOG-MDE" },
    });
    expect(JSON.stringify(row.parsedPayload)).not.toContain("amountCents");

    const [txRow] = await db
      .select({
        enrichedMerchant: transactions.enrichedMerchant,
        enrichmentSource: transactions.enrichmentSource,
        descriptionRaw: transactions.descriptionRaw,
      })
      .from(transactions)
      .where(eq(transactions.id, tx.id));
    expect(txRow.enrichedMerchant).toBeNull();
    expect(txRow.enrichmentSource).toBeNull();
    expect(txRow.descriptionRaw).toBe("COMPRA JETSMART");
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
