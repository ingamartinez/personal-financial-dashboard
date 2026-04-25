/**
 * Pull-engine integration tests for the enrich-mode receipt flow (#454).
 * Covers the processPendingEnrichReceipts path wired into pullForUser.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import type { AuthedGmailClient } from "./client";
import { pullForUser } from "./pull";
import { GATEWAYS } from "./registry";

const TAG = "VITEST_ENRICH_PULL_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userId: number;
let accountId: number;
let connId: number;

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM classification_rules WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM transactions WHERE account_id = ${accountId}`);
}

async function seedTx(opts: {
  descriptionRaw: string;
  amountCents: bigint;
  occurredAt: Date;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: opts.occurredAt,
      amountCents: opts.amountCents,
      currency: "COP",
      descriptionRaw: opts.descriptionRaw,
      classificationMethod: "unclassified",
      source: "sms",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function seedReceipt(opts: {
  gateway: "mercado_pago" | "payu" | "wompi" | "apple" | "paypal";
  amountCents: bigint;
  occurredAt: Date;
  merchant: string;
  matchStatus?: "pending" | "matched" | "ambiguous" | "unmatched";
}): Promise<number> {
  // parsedAt is set so the pull engine skips the parse step and goes straight
  // to matching. Integration tests care about the match/enrich path, not the
  // parse step (which is unit-tested in parsers/*.test.ts).
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: `${TAG}${Date.now()}-${Math.random()}`,
      gateway: opts.gateway,
      amountCents: opts.amountCents,
      occurredAt: opts.occurredAt,
      merchant: opts.merchant,
      rawHtml: "<html>receipt</html>",
      parsedAt: new Date(),
      matchStatus: opts.matchStatus ?? "pending",
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

/**
 * A fake authed client that returns no new Gmail messages — we only care
 * about the post-pull processing of pre-seeded receipts.
 */
function makeNoopClient(): AuthedGmailClient {
  return {
    oauth: {} as unknown,
    gmail: {
      users: {
        messages: {
          async list() {
            return { data: { messages: [], nextPageToken: undefined } };
          },
          async get() {
            return { data: {} };
          },
        },
      },
    },
    connection: {
      id: connId,
      gmailEmail: `${TAG}${userId}@example.com`,
      accessTokenStale: false,
    },
  } as unknown as AuthedGmailClient;
}

beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

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
  await db
    .insert(categories)
    .values([
      { userId, slug: "delivery", name: "Delivery", icon: "truck", color: "#3b82f6", sortOrder: 1 },
    ]);

  const [c] = await db
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
  connId = c.id;
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM gmail_connections WHERE id = ${connId}`);
  await db.execute(sql`DELETE FROM categories WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM accounts WHERE id = ${accountId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

describe("processPendingEnrichReceipts (via pullForUser)", () => {
  it("end-to-end: matched receipt enriches and reclassifies the transaction", async () => {
    const DATE = new Date("2026-04-19T10:00:00Z");
    const AMOUNT = BigInt(65990);

    const txId = await seedTx({
      descriptionRaw: "MERCADOPAGO COLOMBIA e2e-test",
      amountCents: -AMOUNT,
      occurredAt: DATE,
    });
    const receiptId = await seedReceipt({
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
      merchant: "Rappi",
    });

    // Insert a rule that matches "Rappi" so reclassify also fires.
    await db.insert(classificationRules).values({
      userId,
      pattern: "%Rappi%",
      categorySlug: "delivery",
      priority: 5,
      active: true,
    });

    await pullForUser(userId, {}, { getClient: async () => makeNoopClient() });

    const [tx] = await db
      .select({
        enrichedMerchant: transactions.enrichedMerchant,
        enrichmentSource: transactions.enrichmentSource,
        categorySlug: transactions.categorySlug,
        classificationMethod: transactions.classificationMethod,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));

    expect(tx.enrichedMerchant).toBe("Rappi");
    expect(tx.enrichmentSource).toBe("gmail");
    expect(tx.categorySlug).toBe("delivery");
    expect(tx.classificationMethod).toBe("rule_retroactive");

    const [receipt] = await db
      .select({ matchStatus: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));
    expect(receipt.matchStatus).toBe("matched");
  });

  it("ingest-mode gateway (bancolombia) is NOT processed by the enrich loop", async () => {
    // Insert a bancolombia receipt — it should stay pending (not routed through
    // the enrich loop which only touches mode=enrich gateways).
    const receiptId = await db
      .insert(emailReceipts)
      .values({
        userId,
        gmailConnectionId: connId,
        gmailMsgId: `${TAG}banc-${Date.now()}`,
        gateway: "bancolombia",
        rawHtml: "<html>banc</html>",
        matchStatus: "pending",
      })
      .returning({ id: emailReceipts.id })
      .then(([r]) => r.id);

    // The enrich loop uses GATEWAYS.filter(g => g.mode === "enrich") so
    // bancolombia should never be processed. Pull with just mercado_pago
    // selected to avoid triggering the bancolombia ingest path.
    await pullForUser(
      userId,
      { gateways: ["mercado_pago"] },
      { getClient: async () => makeNoopClient() },
    );

    const [receipt] = await db
      .select({ matchStatus: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));

    // Receipt must remain pending (bancolombia ingest path not triggered here,
    // enrich path correctly excluded it).
    expect(receipt.matchStatus).toBe("pending");
  });

  it("unmatched receipt gets status=unmatched and is re-attempted on the next pull", async () => {
    const DATE = new Date("2026-04-19T10:00:00Z");
    const AMOUNT = BigInt(99999);

    // First pull: no corresponding tx exists → receipt becomes unmatched.
    const receiptId = await seedReceipt({
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
      merchant: "RetryMerchant",
    });

    await pullForUser(userId, {}, { getClient: async () => makeNoopClient() });

    const [afterFirst] = await db
      .select({ matchStatus: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));

    expect(afterFirst.matchStatus).toBe("unmatched");

    // Bank tx arrives later (e.g. via SMS ingestion). Seed it now.
    const txId = await seedTx({
      descriptionRaw: "MERCADOPAGO COLOMBIA retry-test",
      amountCents: -AMOUNT,
      occurredAt: DATE,
    });

    // Second pull: the unmatched receipt is re-selected and matched this time.
    await pullForUser(userId, {}, { getClient: async () => makeNoopClient() });

    const [afterSecond] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchedTransactionId: emailReceipts.matchedTransactionId,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));

    expect(afterSecond.matchStatus).toBe("matched");
    expect(afterSecond.matchedTransactionId).toBe(txId);

    const [tx] = await db
      .select({
        enrichedMerchant: transactions.enrichedMerchant,
        enrichmentSource: transactions.enrichmentSource,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));

    expect(tx.enrichedMerchant).toBe("RetryMerchant");
    expect(tx.enrichmentSource).toBe("gmail");
  });

  it("ambiguous receipt gets status=ambiguous with matchCandidates populated", async () => {
    const DATE = new Date("2026-04-18T10:00:00Z");
    const AMOUNT = BigInt(12345);

    // Two txs in the window — should cause ambiguous.
    await seedTx({
      descriptionRaw: "MERCADOPAGO COLOMBIA amb-1",
      amountCents: -AMOUNT,
      occurredAt: DATE,
    });
    await seedTx({
      descriptionRaw: "MERCADOPAGO COLOMBIA amb-2",
      amountCents: -AMOUNT,
      occurredAt: new Date(DATE.getTime() + 30_000),
    });
    const receiptId = await seedReceipt({
      gateway: "mercado_pago",
      amountCents: AMOUNT,
      occurredAt: DATE,
      merchant: "AmbiguousMerchant",
    });

    await pullForUser(userId, {}, { getClient: async () => makeNoopClient() });

    const [receipt] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchCandidates: emailReceipts.matchCandidates,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));

    expect(receipt.matchStatus).toBe("ambiguous");
    expect(Array.isArray(receipt.matchCandidates)).toBe(true);
    expect((receipt.matchCandidates as number[]).length).toBe(2);
  });

  it("all enrich gateways in GATEWAYS registry have mode=enrich (registry coverage)", () => {
    const enrichGateways = GATEWAYS.filter((g) => g.mode === "enrich");
    const ingestGateways = GATEWAYS.filter((g) => g.mode === "ingest");

    // All enrich gateways must have a bankDescriptionRegex.
    for (const g of enrichGateways) {
      expect(g.bankDescriptionRegex).not.toBeNull();
    }
    // All ingest gateways must NOT have a bankDescriptionRegex.
    for (const g of ingestGateways) {
      expect(g.bankDescriptionRegex).toBeNull();
    }
  });
});
