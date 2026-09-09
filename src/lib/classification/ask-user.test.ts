import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  emailReceipts,
  gmailConnections,
  transactions,
  users,
  type ClassificationReasonJson,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { ASK_TTL_MS } from "./ask-user";

const mocks = vi.hoisted(() => ({
  pushToUser: vi.fn(),
  getLatestSessionByUserId: vi.fn(),
  upsertSession: vi.fn(),
  enqueueClassification: vi.fn(),
}));

vi.mock("@/lib/telegram/push", () => ({
  pushToUser: mocks.pushToUser,
}));

vi.mock("@/lib/telegram/session", () => ({
  getLatestSessionByUserId: mocks.getLatestSessionByUserId,
  upsertSession: mocks.upsertSession,
}));

vi.mock("@/lib/classification/enqueue", () => ({
  enqueueClassification: mocks.enqueueClassification,
  enqueueAskUser: vi.fn(),
}));

const {
  processAskForUser,
  applyClassificationAnswer,
  applyClassificationAnswerByIndex,
  skipClassificationQuestion,
  expireStaleAsks,
} = await import("./ask-user");

const TAG = "ASK_USER_TEST";

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
  categorySlug?: string | null;
  classificationMethod?: "user_uncategorized" | "unclassified";
  amountCents?: number;
  occurredAt?: Date;
  reason?: Record<string, unknown> | null;
}): Promise<number> {
  seq++;
  const reason =
    args.reason === undefined
      ? { action: "abstained", reason: "opaque_gateway", gateway: "mercado_pago" }
      : args.reason;
  const [row] = await db
    .insert(transactions)
    .values({
      userId: args.userId,
      accountId: args.accountId,
      occurredAt: args.occurredAt ?? new Date(),
      amountCents: BigInt(args.amountCents ?? -79_996_000),
      currency: "COP",
      descriptionRaw: args.descriptionRaw,
      categorySlug: args.categorySlug ?? "otros",
      classificationMethod: args.classificationMethod ?? "user_uncategorized",
      classificationConfidence: 0,
      source: "sms",
      externalId: `${TAG}-${seq}`,
      channel: "bank",
      classificationReason: reason as ClassificationReasonJson | null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function getTx(id: number) {
  const [row] = await db
    .select({
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
}

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

const idleSession = {
  chatId: BigInt(7001),
  telegramUserId: BigInt(8001),
  state: { step: "idle" as const, draft: {}, sourceChatId: 7001 },
};

describe("processAskForUser", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    await cleanup();
  });
  afterAll(cleanup);

  async function setup() {
    userId = await createUser(`${TAG}-${Date.now()}-${Math.random()}@test.local`);
    accountId = await createAccount(userId);
    mocks.pushToUser.mockReset();
    mocks.pushToUser.mockResolvedValue({ ok: true });
    mocks.getLatestSessionByUserId.mockReset();
    mocks.getLatestSessionByUserId.mockResolvedValue(idleSession);
    mocks.upsertSession.mockReset();
    mocks.upsertSession.mockResolvedValue(undefined);
    mocks.enqueueClassification.mockReset();
    mocks.enqueueClassification.mockResolvedValue(undefined);
  }

  afterEach(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  it("asks about an opaque abstained row with zero correlation candidates", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
    });

    const result = await processAskForUser(userId);

    expect(result.askedTxId).toBe(txId);
    expect(result.skipped).toBeNull();
    expect(mocks.pushToUser).toHaveBeenCalledOnce();
    const [, text, , markup] = mocks.pushToUser.mock.calls[0]!;
    expect(text).toMatch(/MERCADOPAGO COLOMBIA/);
    expect(markup).toEqual(
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ callback_data: expect.stringMatching(/^cq:/) }),
          ]),
        ]),
      }),
    );
    const row = await getTx(txId);
    expect(row?.classificationReason).toMatchObject({
      action: "awaiting_user",
      reason: "opaque_gateway",
    });
    expect(Array.isArray((row?.classificationReason as { offered?: string[] }).offered)).toBe(true);
    expect(mocks.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          step: "awaiting_classification",
          classificationTxId: txId,
        }),
      }),
    );
  });

  it("does not ask about a transfer-pair abstain", async () => {
    await setup();
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "PAGO CREDITO",
      reason: { action: "abstained", reason: "probable_transfer_pair", pairedTxId: 1 },
    });

    const result = await processAskForUser(userId);
    expect(result.askedTxId).toBeNull();
    expect(result.skipped).toBe("no_eligible");
    expect(mocks.pushToUser).not.toHaveBeenCalled();
  });

  it("does not ask about a swept row", async () => {
    await setup();
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      reason: { action: "swept", run: new Date().toISOString() },
    });

    const result = await processAskForUser(userId);
    expect(result.skipped).toBe("no_eligible");
    expect(mocks.pushToUser).not.toHaveBeenCalled();
  });

  it("sends at most one question when two opaque rows are eligible", async () => {
    await setup();
    const newer = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      occurredAt: new Date("2026-02-01T00:00:00Z"),
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      occurredAt: new Date("2026-01-31T00:00:00Z"),
    });

    const result = await processAskForUser(userId);
    expect(result.askedTxId).toBe(newer);
    expect(mocks.pushToUser).toHaveBeenCalledOnce();

    const second = await processAskForUser(userId);
    expect(second.skipped).toBe("outstanding");
    expect(second.askedTxId).toBeNull();
    expect(mocks.pushToUser).toHaveBeenCalledOnce();
  });

  it("skips when a disambiguation session is already open", async () => {
    await setup();
    await insertTx({ userId, accountId, descriptionRaw: "MERCADOPAGO COLOMBIA" });
    mocks.getLatestSessionByUserId.mockResolvedValue({
      ...idleSession,
      state: { step: "awaiting_disambiguation", draft: {}, sourceChatId: 7001 },
    });

    const result = await processAskForUser(userId);
    expect(result.skipped).toBe("session_open");
    expect(mocks.pushToUser).not.toHaveBeenCalled();
    const rows = await db
      .select({ reason: transactions.classificationReason })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    expect(rows[0]?.reason).toMatchObject({ action: "abstained" });
  });

  it("skips when the user has no Telegram session", async () => {
    await setup();
    await insertTx({ userId, accountId, descriptionRaw: "MERCADOPAGO COLOMBIA" });
    mocks.getLatestSessionByUserId.mockResolvedValue(null);

    const result = await processAskForUser(userId);
    expect(result.skipped).toBe("no_channel");
    expect(mocks.pushToUser).not.toHaveBeenCalled();
  });

  it("reverts the stamp when Telegram send fails", async () => {
    await setup();
    const txId = await insertTx({ userId, accountId, descriptionRaw: "MERCADOPAGO COLOMBIA" });
    mocks.pushToUser.mockResolvedValue({ ok: false, reason: "send_failed" });

    const result = await processAskForUser(userId);
    expect(result.skipped).toBe("send_failed");
    const row = await getTx(txId);
    expect(row?.classificationReason).toMatchObject({
      action: "abstained",
      reason: "opaque_gateway",
    });
  });

  it("expires an unanswered question back to abstained and becomes re-askable", async () => {
    await setup();
    const txId = await insertTx({ userId, accountId, descriptionRaw: "MERCADOPAGO COLOMBIA" });
    const first = await processAskForUser(userId);
    expect(first.askedTxId).toBe(txId);

    const expired = await expireStaleAsks(userId, Date.now() + ASK_TTL_MS + 1_000);
    expect(expired).toBe(1);
    const row = await getTx(txId);
    expect(row?.classificationReason).toMatchObject({
      action: "abstained",
      reason: "opaque_gateway",
    });
    expect((row?.classificationReason as { askedAt?: string }).askedAt).toBeUndefined();

    mocks.pushToUser.mockClear();
    const second = await processAskForUser(userId);
    expect(second.askedTxId).toBe(txId);
    expect(mocks.pushToUser).toHaveBeenCalledOnce();
  });

  it("does not treat answering one MercadoPago row as prior art for another", async () => {
    await setup();
    const tickets = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      occurredAt: new Date("2026-01-31T10:39:00Z"),
    });
    const mattress = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      occurredAt: new Date("2026-02-10T18:00:00Z"),
    });

    const first = await processAskForUser(userId);
    expect(first.askedTxId).toBe(mattress);
    const answered = await applyClassificationAnswer({
      userId,
      txId: mattress,
      categorySlug: "hogar",
    });
    expect(answered).toEqual({ ok: true, categorySlug: "hogar" });

    const mattressRow = await getTx(mattress);
    expect(mattressRow?.classificationMethod).toBe("manual");
    expect(mattressRow?.classificationReason).toMatchObject({ action: "manual" });
    expect(mattressRow?.classificationReason).not.toMatchObject({ action: "abstained" });

    const second = await processAskForUser(userId);
    expect(second.askedTxId).toBe(tickets);
  });
});

describe("applyClassificationAnswer", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    await cleanup();
  });
  afterAll(cleanup);

  async function setup() {
    userId = await createUser(`${TAG}-ans-${Date.now()}-${Math.random()}@test.local`);
    accountId = await createAccount(userId);
  }

  afterEach(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  it("replaces the abstained reason and does not write a gateway merchant hint", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      reason: {
        action: "awaiting_user",
        reason: "opaque_gateway",
        gateway: "mercado_pago",
        askedAt: new Date().toISOString(),
        offered: ["hogar", "entretenimiento"],
      },
    });

    const result = await applyClassificationAnswerByIndex({ userId, txId, index: 0 });
    expect(result).toEqual({ ok: true, categorySlug: "hogar" });

    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("hogar");
    expect(row?.classificationMethod).toBe("manual");
    expect(row?.classificationReason).toEqual({ action: "manual", via: "telegram" });

    const [userRow] = await db
      .select({ context: users.classificationContext })
      .from(users)
      .where(eq(users.id, userId));
    expect(userRow?.context?.merchant_hints ?? []).toHaveLength(0);
  });

  it("skipClassificationQuestion returns the row to abstained", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      reason: {
        action: "awaiting_user",
        reason: "opaque_gateway",
        gateway: "mercado_pago",
        askedAt: new Date().toISOString(),
        offered: ["hogar"],
      },
    });

    await skipClassificationQuestion({ userId, txId });
    const row = await getTx(txId);
    expect(row?.classificationReason).toMatchObject({
      action: "abstained",
      reason: "opaque_gateway",
      gateway: "mercado_pago",
    });
    expect((row?.classificationReason as { askedAt?: string }).askedAt).toBeUndefined();
  });

  it("rejects a category that is not in this user's taxonomy (tenant-safe)", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      reason: {
        action: "awaiting_user",
        reason: "opaque_gateway",
        offered: ["not-a-real-slug"],
      },
    });
    const result = await applyClassificationAnswer({
      userId,
      txId,
      categorySlug: "not-a-real-slug",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_category" });
  });
});

describe("late evidence requeue", () => {
  const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
  const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];
  let userId: number;
  let accountId: number;
  let connId: number;

  beforeAll(async () => {
    process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    await cleanup();
  });
  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
    else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
    return cleanup();
  });

  afterEach(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  it("resets an abstained row to unclassified when a receipt now correlates", async () => {
    userId = await createUser(`${TAG}-ev-${Date.now()}-${Math.random()}@test.local`);
    accountId = await createAccount(userId);
    mocks.pushToUser.mockReset();
    mocks.pushToUser.mockResolvedValue({ ok: true });
    mocks.getLatestSessionByUserId.mockResolvedValue(idleSession);
    mocks.upsertSession.mockResolvedValue(undefined);
    mocks.enqueueClassification.mockReset();
    mocks.enqueueClassification.mockResolvedValue(undefined);

    const [conn] = await db
      .insert(gmailConnections)
      .values({
        userId,
        gmailEmail: `${TAG}-${userId}@example.com`,
        accessTokenEnc: gmailCipher.encrypt("tok"),
        refreshTokenEnc: gmailCipher.encrypt("ref"),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        status: "active",
      })
      .returning({ id: gmailConnections.id });
    connId = conn.id;

    const occurredAt = new Date("2026-01-26T01:15:00Z");
    await db.insert(emailReceipts).values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: `${TAG}-ev-${Date.now()}`,
      gateway: "mercado_pago",
      merchant: "Almohada Ortopédica",
      amountCents: BigInt(85_211_00),
      currency: "COP",
      occurredAt,
      emailReceivedAt: occurredAt,
      rawHtml: "<html></html>",
      parsedPayload: {
        merchant: "Almohada Ortopédica",
        amountCents: String(85_211_00),
        currency: "COP",
        occurredAt: occurredAt.toISOString(),
        referenceId: "400227",
      },
      matchStatus: "unmatched",
    });

    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      amountCents: -85_211_00,
      occurredAt,
    });

    const result = await processAskForUser(userId);
    expect(result.requeuedCount).toBe(1);
    expect(result.askedTxId).toBeNull();
    expect(mocks.pushToUser).not.toHaveBeenCalled();
    expect(mocks.enqueueClassification).toHaveBeenCalledWith(userId, [txId]);

    const row = await getTx(txId);
    expect(row?.categorySlug).toBeNull();
    expect(row?.classificationMethod).toBe("unclassified");
    expect(row?.classificationReason).toBeNull();
  });
});
