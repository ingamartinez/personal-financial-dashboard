import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  emailReceipts,
  gmailConnections,
  merchantKnowledge,
  users,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import {
  backfillMerchantKnowledge,
  canonicalMerchantKey,
  fetchMerchantKnowledgeIndex,
  isOpaqueMerchantKey,
  lookupMerchantKnowledge,
} from "./merchant-knowledge";

const TAG = "MK_TEST";

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({ userId, name: `${TAG} account`, institution: TAG, type: "savings", currency: "COP" })
    .returning({ id: accounts.id });
  return row.id;
}

let seq = 0;
async function insertTx(args: {
  userId: number;
  accountId: number;
  descriptionRaw: string;
  categorySlug: string | null;
  classificationMethod: string;
  merchant?: string | null;
  canonicalMerchant?: string | null;
  classificationReason?: Record<string, unknown> | null;
}): Promise<number> {
  seq++;
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, merchant, canonical_merchant, category_slug,
      classification_method, classification_reason, source, external_id, channel
    ) VALUES (
      ${args.userId}, ${args.accountId}, now(), -10000, 'COP',
      ${args.descriptionRaw}, ${args.merchant ?? null}, ${args.canonicalMerchant ?? null},
      ${args.categorySlug}, ${args.classificationMethod}::classification_method,
      ${args.classificationReason ? JSON.stringify(args.classificationReason) : null}::jsonb,
      'sms', ${`${TAG}-${seq}`}, 'bank'::tx_channel
    )
    RETURNING id
  `);
  return row.id;
}

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
  await db.delete(merchantKnowledge).where(sql`canonical_merchant LIKE ${TAG.toLowerCase() + "%"}`);
}

describe("canonicalMerchantKey", () => {
  it("prefers stored canonical_merchant, then merchant, then description", () => {
    expect(
      canonicalMerchantKey({
        canonicalMerchant: "Didi",
        merchant: "DLO*Didi",
        descriptionRaw: "something else",
      }),
    ).toBe("didi");
    expect(
      canonicalMerchantKey({
        canonicalMerchant: null,
        merchant: "DLO*Didi",
        descriptionRaw: "ignored",
      }),
    ).toBe("didi");
  });

  it("returns null for skip-pattern descriptions with no merchant", () => {
    expect(
      canonicalMerchantKey({
        canonicalMerchant: null,
        merchant: null,
        descriptionRaw: "Pago TC *1234",
      }),
    ).toBeNull();
  });
});

describe("isOpaqueMerchantKey", () => {
  it("rejects gateway strings so they can never be a KB key", () => {
    expect(isOpaqueMerchantKey("mercadopago colombia")).toBe(true);
    expect(isOpaqueMerchantKey("wompi*tienda")).toBe(true);
    expect(isOpaqueMerchantKey("oxxo")).toBe(false);
  });
});

describe("merchant knowledge backfill + lookup", () => {
  const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
  const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

  beforeAll(() => {
    process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
    else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
    await cleanup();
  });

  it("writes a per-user hint from two agreeing non-manual rows and looks it up", async () => {
    const userId = await createUser(`${TAG}-agree-${Date.now()}@test.local`);
    const accountId = await createAccount(userId);
    const merchant = `${TAG} OXXO Agree`;
    for (let i = 0; i < 2; i++) {
      await insertTx({
        userId,
        accountId,
        descriptionRaw: merchant,
        merchant,
        canonicalMerchant: merchant,
        categorySlug: "mercado",
        classificationMethod: "ai",
      });
    }

    const result = await backfillMerchantKnowledge({ userId });
    expect(result.merchantsUpserted).toBe(1);
    expect(result.hintsUpserted).toBe(1);

    const key = merchant.toLowerCase();
    const hit = await lookupMerchantKnowledge(userId, key);
    expect(hit).toMatchObject({
      canonicalMerchant: key,
      categorySlug: "mercado",
      isGateway: false,
    });

    const index = await fetchMerchantKnowledgeIndex(userId);
    expect(index.get(key)).toBe("mercado");
  });

  it("one non-manual row is not enough for a hint", async () => {
    const userId = await createUser(`${TAG}-one-${Date.now()}@test.local`);
    const accountId = await createAccount(userId);
    const merchant = `${TAG} Lone AI`;
    await insertTx({
      userId,
      accountId,
      descriptionRaw: merchant,
      merchant,
      canonicalMerchant: merchant,
      categorySlug: "mercado",
      classificationMethod: "ai",
    });

    const result = await backfillMerchantKnowledge({ userId });
    expect(result.merchantsUpserted).toBe(1);
    expect(result.hintsUpserted).toBe(0);
    expect(result.skippedAmbiguous).toBe(1);
    expect(await lookupMerchantKnowledge(userId, merchant.toLowerCase())).toMatchObject({
      categorySlug: null,
    });
  });

  it("a single manual row is enough", async () => {
    const userId = await createUser(`${TAG}-man-${Date.now()}@test.local`);
    const accountId = await createAccount(userId);
    const merchant = `${TAG} Manual Only`;
    await insertTx({
      userId,
      accountId,
      descriptionRaw: merchant,
      merchant,
      canonicalMerchant: merchant,
      categorySlug: "vivienda",
      classificationMethod: "manual",
    });

    const result = await backfillMerchantKnowledge({ userId });
    expect(result.hintsUpserted).toBe(1);
    expect(await lookupMerchantKnowledge(userId, merchant.toLowerCase())).toMatchObject({
      categorySlug: "vivienda",
    });
  });

  it("does not key opaque gateway strings — even classified ones without a receipt", async () => {
    const userId = await createUser(`${TAG}-gw-${Date.now()}@test.local`);
    const accountId = await createAccount(userId);
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      merchant: "MERCADOPAGO COLOMBIA",
      canonicalMerchant: "MERCADOPAGO COLOMBIA",
      categorySlug: "hogar",
      classificationMethod: "manual",
    });

    const result = await backfillMerchantKnowledge({ userId });
    expect(result.skippedOpaque).toBe(1);
    expect(result.merchantsUpserted).toBe(0);
    expect(result.hintsUpserted).toBe(0);
    expect(await lookupMerchantKnowledge(userId, "mercadopago colombia")).toBeNull();
  });

  it("opaque rows with a receipt citation key on receipt.merchant, never the gateway string", async () => {
    const userId = await createUser(`${TAG}-rcpt-${Date.now()}@test.local`);
    const accountId = await createAccount(userId);
    const [conn] = await db
      .insert(gmailConnections)
      .values({
        userId,
        gmailEmail: `${TAG}-rcpt-${userId}@example.com`,
        accessTokenEnc: gmailCipher.encrypt("dummy-access"),
        refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        status: "active",
      })
      .returning({ id: gmailConnections.id });
    const receiptMerchant = `${TAG} Almohada`;
    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId,
        gmailConnectionId: conn.id,
        gmailMsgId: `${TAG}-rcpt-${Date.now()}`,
        gateway: "mercado_pago",
        merchant: receiptMerchant,
        amountCents: BigInt(8_521_100),
        currency: "COP",
        occurredAt: new Date(),
        emailReceivedAt: new Date(),
        rawHtml: "<html></html>",
        parsedPayload: {
          merchant: receiptMerchant,
          amountCents: "8521100",
          currency: "COP",
          occurredAt: new Date().toISOString(),
          referenceId: "1",
        },
        matchStatus: "unmatched",
      })
      .returning({ id: emailReceipts.id });

    await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      merchant: "MERCADOPAGO COLOMBIA",
      canonicalMerchant: "MERCADOPAGO COLOMBIA",
      categorySlug: "hogar",
      classificationMethod: "manual",
      classificationReason: { receiptId: receipt.id, matchKind: "exact_amount" },
    });

    const result = await backfillMerchantKnowledge({ userId });
    expect(result.skippedOpaque).toBe(0);
    expect(result.hintsUpserted).toBe(1);

    const key = receiptMerchant.toLowerCase();
    expect(await lookupMerchantKnowledge(userId, key)).toMatchObject({ categorySlug: "hogar" });
    expect(await lookupMerchantKnowledge(userId, "mercadopago colombia")).toBeNull();
  });

  it("does not leak another user's hint", async () => {
    const userA = await createUser(`${TAG}-ten-a-${Date.now()}@test.local`);
    const userB = await createUser(`${TAG}-ten-b-${Date.now()}@test.local`);
    const accountA = await createAccount(userA);
    const merchant = `${TAG} Tenant`;
    await insertTx({
      userId: userA,
      accountId: accountA,
      descriptionRaw: merchant,
      merchant,
      canonicalMerchant: merchant,
      categorySlug: "mercado",
      classificationMethod: "manual",
    });

    await backfillMerchantKnowledge({ userId: userA });
    expect(await lookupMerchantKnowledge(userB, merchant.toLowerCase())).toMatchObject({
      categorySlug: null,
    });
    const indexB = await fetchMerchantKnowledgeIndex(userB);
    expect(indexB.has(merchant.toLowerCase())).toBe(false);
  });

  it("is idempotent — a second run writes nothing", async () => {
    const userId = await createUser(`${TAG}-idemp-${Date.now()}@test.local`);
    const accountId = await createAccount(userId);
    const merchant = `${TAG} Idemp`;
    await insertTx({
      userId,
      accountId,
      descriptionRaw: merchant,
      merchant,
      canonicalMerchant: merchant,
      categorySlug: "mercado",
      classificationMethod: "manual",
    });

    const first = await backfillMerchantKnowledge({ userId });
    expect(first.hintsUpserted).toBe(1);
    const second = await backfillMerchantKnowledge({ userId });
    expect(second.merchantsUpserted).toBe(0);
    expect(second.hintsUpserted).toBe(0);
  });

  it("skips otros and does not write a hint", async () => {
    const userId = await createUser(`${TAG}-otros-${Date.now()}@test.local`);
    const accountId = await createAccount(userId);
    await insertTx({
      userId,
      accountId,
      descriptionRaw: `${TAG} Otros Merchant`,
      merchant: `${TAG} Otros Merchant`,
      canonicalMerchant: `${TAG} Otros Merchant`,
      categorySlug: "otros",
      classificationMethod: "ai",
    });

    const result = await backfillMerchantKnowledge({ userId });
    expect(result.merchantsUpserted).toBe(0);
    expect(result.hintsUpserted).toBe(0);
  });
});
