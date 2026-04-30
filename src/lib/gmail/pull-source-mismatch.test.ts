// Tests for gmail_source_mismatch emit from the cron/realtime pull path (#665).
// Uses vi.hoisted + vi.mock arrow-form factories (block-body triggers ESLint).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, gmailConnections, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import type { AuthedGmailClient } from "./client";
import { pullForUser } from "./pull";
import { backfillBancolombia } from "./backfill";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 999 }),
  ingestParsedEmail: vi.fn(),
  parseBancolombiaEmail: vi.fn(),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

vi.mock("@/lib/ingestion/email-bancolombia", () => ({
  ingestParsedEmail: mocks.ingestParsedEmail,
}));

vi.mock("@/lib/gmail/parsers/bancolombia", () => ({
  parseBancolombiaEmail: mocks.parseBancolombiaEmail,
}));

// ── Constants & setup ─────────────────────────────────────────────────────────

const TAG = "GMAIL_SOURCE_MISMATCH_TEST";
let userId: number;
let connId: number;

const ORIGINAL_GMAIL_KEY = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

async function cleanup() {
  // Delete by email pattern first (works even before userId is set).
  // Cascades aren't set on these tables so we delete in dependency order.
  const matchedUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`email LIKE ${"%" + TAG + "%"}`);
  if (matchedUsers.length > 0) {
    const ids = matchedUsers.map((u) => u.id);
    for (const id of ids) {
      await db.execute(sql`DELETE FROM email_receipts WHERE user_id = ${id}`);
      await db.execute(sql`DELETE FROM gmail_connections WHERE user_id = ${id}`);
    }
    await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
  }
}

// A fake AuthedGmailClient that returns an empty message list so the pull
// gateway loop does nothing — pending receipts seeded below are processed
// by processPendingBancolombiaReceipts separately.
function fakeAuthed(): AuthedGmailClient {
  return {
    oauth: {} as unknown,
    gmail: {
      users: {
        messages: {
          list: vi.fn().mockResolvedValue({ data: { messages: [], nextPageToken: undefined } }),
          get: vi.fn(),
        },
      },
    },
    connection: { id: connId, gmailEmail: `${TAG}@gmail.com`, accessTokenStale: false },
  } as unknown as AuthedGmailClient;
}

// Parsed stub — content doesn't matter because ingestParsedEmail is mocked,
// but parseBancolombiaEmail needs to return something non-null.
const PARSED_STUB = {
  kind: "purchase",
  amountCents: BigInt(4424700),
  currency: "COP",
  merchant: "MERCADOPAGO COLOMBIA",
  cardLast4: "2575",
  cardKind: "credit",
  occurredOn: "2026-04-08",
  occurredTime: "17:38",
  externalId: "bcol-email:stub",
  raw: "stub",
};

beforeAll(async () => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await cleanup();
  const [u] = await db
    .insert(users)
    .values({ email: `${TAG}@test.local`, name: TAG })
    .returning({ id: users.id });
  userId = u.id;
  const [c] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}@gmail.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access-token"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  connId = c.id;
});

afterAll(async () => {
  await cleanup();
  if (ORIGINAL_GMAIL_KEY === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = ORIGINAL_GMAIL_KEY;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitNotification.mockResolvedValue({ id: 999 });
});

afterEach(async () => {
  if (userId) {
    await db.execute(sql`DELETE FROM email_receipts WHERE user_id = ${userId}`);
  }
});

// Helper: insert a pending bancolombia receipt so processPendingBancolombiaReceipts picks it up.
async function seedPendingReceipt(msgId: string): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: msgId,
      gateway: "bancolombia",
      rawHtml: "<html>stub</html>",
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

// ── Pull path tests ───────────────────────────────────────────────────────────

describe("pull path — gmail_source_mismatch emit", () => {
  it("emits gmail_source_mismatch when flaggedMismatch=true", async () => {
    const receiptId = await seedPendingReceipt("msg-mismatch-1");
    const txId = 777;

    mocks.parseBancolombiaEmail.mockReturnValue(PARSED_STUB);
    mocks.ingestParsedEmail.mockResolvedValue({
      status: "duplicated",
      flaggedMismatch: true,
      txId,
    });

    const getClient = async () => fakeAuthed();
    await pullForUser(userId, { gateways: ["bancolombia"] }, { getClient, sleep: async () => {} });

    const mismatchCall = mocks.emitNotification.mock.calls.find(
      (call) => call[1].type === "gmail_source_mismatch",
    );
    expect(mismatchCall).toBeDefined();
    expect(mismatchCall![0]).toBe(userId);
    expect(mismatchCall![1]).toMatchObject({
      type: "gmail_source_mismatch",
      entityId: String(txId),
      priority: "medium",
      metadata: expect.objectContaining({ txId, receiptId, gateway: "bancolombia" }),
    });
  });

  it("does NOT emit when flaggedMismatch=false", async () => {
    await seedPendingReceipt("msg-no-mismatch-1");

    mocks.parseBancolombiaEmail.mockReturnValue(PARSED_STUB);
    mocks.ingestParsedEmail.mockResolvedValue({
      status: "duplicated",
      flaggedMismatch: false,
      txId: 123,
    });

    const getClient = async () => fakeAuthed();
    await pullForUser(userId, { gateways: ["bancolombia"] }, { getClient, sleep: async () => {} });

    const mismatchCall = mocks.emitNotification.mock.calls.find(
      (call) => call[1].type === "gmail_source_mismatch",
    );
    expect(mismatchCall).toBeUndefined();
  });

  it("does NOT emit when status is 'inserted'", async () => {
    await seedPendingReceipt("msg-inserted-1");

    mocks.parseBancolombiaEmail.mockReturnValue(PARSED_STUB);
    mocks.ingestParsedEmail.mockResolvedValue({ status: "inserted", txId: 456 });

    const getClient = async () => fakeAuthed();
    await pullForUser(userId, { gateways: ["bancolombia"] }, { getClient, sleep: async () => {} });

    const mismatchCall = mocks.emitNotification.mock.calls.find(
      (call) => call[1].type === "gmail_source_mismatch",
    );
    expect(mismatchCall).toBeUndefined();
  });
});

// ── Backfill path — intentionally NO per-row emit ─────────────────────────────

describe("backfill path — no per-row gmail_source_mismatch emit", () => {
  it("does NOT emit gmail_source_mismatch even when flaggedMismatch=true", async () => {
    const html = `<!DOCTYPE html><html><body><p>Bancolombia: Compraste COP44.247,00 en MERCADOPAGO con tu T.Cred *2575, el 08/04/2026 a las 17:38.</p></body></html>`;
    const encoded = Buffer.from(html, "utf8").toString("base64url");

    const fakeAuthedClient: AuthedGmailClient = {
      oauth: {} as unknown,
      gmail: {
        users: {
          messages: {
            list: vi
              .fn()
              .mockResolvedValueOnce({
                data: {
                  messages: [{ id: "backfill-msg-1", threadId: "t1" }],
                  nextPageToken: undefined,
                },
              })
              .mockResolvedValue({ data: { messages: [], nextPageToken: undefined } }),
            get: vi.fn().mockResolvedValue({
              data: {
                id: "backfill-msg-1",
                internalDate: String(Date.now()),
                payload: { mimeType: "text/html", body: { data: encoded } },
              },
            }),
          },
        },
      },
      connection: { id: connId, gmailEmail: `${TAG}@gmail.com`, accessTokenStale: false },
    } as unknown as AuthedGmailClient;

    // ingestParsedEmail returns a flagged mismatch
    mocks.ingestParsedEmail.mockResolvedValue({
      status: "duplicated",
      flaggedMismatch: true,
      txId: 888,
    });

    const getClient = async () => fakeAuthedClient;
    await backfillBancolombia(
      userId,
      { from: new Date("2026-01-01"), to: new Date("2026-12-31") },
      { getClient, sleep: async () => {} },
    );

    const mismatchCall = mocks.emitNotification.mock.calls.find(
      (call) => call[1].type === "gmail_source_mismatch",
    );
    // Backfill deliberately skips per-row emit — aggregated count goes in
    // gmail_backfill_complete metadata instead.
    expect(mismatchCall).toBeUndefined();
  });
});
