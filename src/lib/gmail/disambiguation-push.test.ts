/**
 * Tests that lock in the CRITICAL and WARNING fixes from the #456 reviewer pass.
 *
 * Covered:
 *  - CRITICAL #1: getLatestSessionByUserId orders by updatedAt DESC — correct chatId used.
 *  - CRITICAL #2: concurrent maybeNudgeReauth calls deliver exactly one nudge.
 *  - WARNING #3: maybePushDisambiguationPrompt is NOT called when pullForUser has errors.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  emailReceipts,
  gmailConnections,
  telegramBots,
  telegramSessions,
  users,
} from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { telegramCipher } from "@/lib/crypto/telegram-cipher";
import { GmailConnectionUnusableError } from "./client";
import type { AuthedGmailClient } from "./client";

const TAG = "DISAMB_PUSH_TEST";

// ---------------------------------------------------------------------------
// Mock pushToUser so we can count deliveries without real Telegram HTTP calls.
// The mock is hoisted so the factory is available in vi.mock().
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  pushToUser: vi.fn().mockResolvedValue({ ok: true }) as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/telegram/push", () => ({
  pushToUser: mocks.pushToUser,
}));

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: `${TAG}-${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

async function seedActiveConnection(userId: number): Promise<number> {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}-${userId}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access-token"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

async function seedBot(userId: number): Promise<void> {
  await db.insert(telegramBots).values({
    userId,
    tokenEncrypted: telegramCipher.encrypt("fake-token"),
    username: `bot_${TAG}_${userId}`,
    webhookSecret: "secret",
  });
}

async function seedSession(userId: number, chatId: number, updatedAt: Date): Promise<void> {
  await db.insert(telegramSessions).values({
    chatId: BigInt(chatId),
    userId,
    telegramUserId: BigInt(9000),
    state: { step: "idle", draft: {}, sourceChatId: chatId },
    updatedAt,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ORIGINAL_GMAIL_KEY = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

let userId: number;
let connId: number;

beforeAll(async () => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await cleanup();
  userId = await createUser("main");
});

beforeEach(async () => {
  await db.delete(emailReceipts).where(sql`user_id = ${userId}`);
  await db.delete(gmailConnections).where(sql`user_id = ${userId}`);
  await db.delete(telegramBots).where(sql`username LIKE ${`bot_${TAG}_%`}`);
  await db.delete(telegramSessions).where(sql`user_id = ${userId}`);
  mocks.pushToUser.mockClear();
  mocks.pushToUser.mockResolvedValue({ ok: true });
  connId = await seedActiveConnection(userId);
});

afterAll(async () => {
  await cleanup();
  if (ORIGINAL_GMAIL_KEY === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = ORIGINAL_GMAIL_KEY;
});

// ---------------------------------------------------------------------------
// Import pullForUser after mocks are established.
// ---------------------------------------------------------------------------
const { pullForUser } = await import("./pull");

// ---------------------------------------------------------------------------
// CRITICAL #2 — concurrent re-auth nudge throttle
// ---------------------------------------------------------------------------

describe("maybeNudgeReauth — atomic throttle (CRITICAL #2)", () => {
  it("delivers exactly one nudge when two pulls race on a revoked connection", async () => {
    await seedBot(userId);
    await seedSession(userId, 1001, new Date());

    // Both pulls see the same expired connection via GmailConnectionUnusableError.
    // The atomic UPDATE with RETURNING ensures only one wins the 24h throttle slot.
    const getClient = async (): Promise<AuthedGmailClient> => {
      throw new GmailConnectionUnusableError("expired", "token expired");
    };

    await Promise.all([
      pullForUser(userId, {}, { getClient }),
      pullForUser(userId, {}, { getClient }),
    ]);

    // Exactly one call to pushToUser must have reached Telegram — the second
    // concurrent pull must have lost the atomic race and been throttled.
    const nudgeCalls = mocks.pushToUser.mock.calls.filter(
      (args: unknown[]) => typeof args[1] === "string" && (args[1] as string).includes("Gmail"),
    );
    expect(nudgeCalls.length).toBe(1);
  });

  it("does not nudge when already sent within 24h", async () => {
    await seedBot(userId);
    await seedSession(userId, 1002, new Date());

    // Mark nudge as already sent less than 24h ago.
    await db
      .update(gmailConnections)
      .set({ botNudgeSentAt: new Date(Date.now() - 60_000) }) // 1 minute ago
      .where(eq(gmailConnections.id, connId));

    const getClient = async (): Promise<AuthedGmailClient> => {
      throw new GmailConnectionUnusableError("expired", "token expired");
    };

    await pullForUser(userId, {}, { getClient });

    const nudgeCalls = mocks.pushToUser.mock.calls.filter(
      (args: unknown[]) => typeof args[1] === "string" && (args[1] as string).includes("Gmail"),
    );
    expect(nudgeCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL #1 — session ordering regression
// Directly tests the getLatestSessionByUserId helper that maybePushDisambiguationPrompt
// now delegates to, instead of going through the full pull pipeline (which would
// require seeding accounts + transactions).
// ---------------------------------------------------------------------------

describe("getLatestSessionByUserId — session ordering (CRITICAL #1)", () => {
  it("returns the session with the highest updatedAt when the user has multiple sessions", async () => {
    const { getLatestSessionByUserId } = await import("@/lib/telegram/session");

    const older = new Date("2026-04-20T10:00:00Z");
    const newer = new Date("2026-04-25T12:00:00Z");

    // Seed two sessions for the same user — stale chatId 2000, fresh chatId 2001.
    await seedSession(userId, 2000, older);
    await seedSession(userId, 2001, newer);

    const result = await getLatestSessionByUserId(userId);

    // Must return chatId 2001 (the newer session), not 2000 (the older one).
    expect(result).not.toBeNull();
    expect(Number(result!.chatId)).toBe(2001);
  });

  it("returns null when user has no sessions", async () => {
    const { getLatestSessionByUserId } = await import("@/lib/telegram/session");
    const result = await getLatestSessionByUserId(userId);
    expect(result).toBeNull();
  });

  it("exposes telegramUserId so upsertSession can use it", async () => {
    const { getLatestSessionByUserId } = await import("@/lib/telegram/session");
    await seedSession(userId, 2002, new Date());
    const result = await getLatestSessionByUserId(userId);
    expect(result?.telegramUserId).toBeDefined();
    expect(typeof result?.telegramUserId).toBe("bigint");
  });
});

// ---------------------------------------------------------------------------
// WARNING #3 — disambiguation push gated on clean pull
// ---------------------------------------------------------------------------

describe("maybePushDisambiguationPrompt — error gating (WARNING #3)", () => {
  it("does not push disambiguation prompt when pullForUser has errors", async () => {
    await seedBot(userId);
    await seedSession(userId, 3001, new Date());

    // A pull that has per-message errors (empty payload → error, watermark stays).
    const getClient = async (): Promise<AuthedGmailClient> => {
      return {
        oauth: {} as unknown,
        gmail: {
          users: {
            messages: {
              async list(params: { q?: string }) {
                if (params.q?.includes("mercadopago.com.co")) {
                  return { data: { messages: [{ id: "err-msg", threadId: "err-msg" }] } };
                }
                return { data: { messages: [] } };
              },
              async get() {
                // No payload → triggers per-message error.
                return { data: { id: "err-msg", payload: {} } };
              },
            },
          },
        },
        connection: {
          id: connId,
          gmailEmail: `${TAG}-${userId}@example.com`,
          accessTokenStale: false,
        },
      } as unknown as AuthedGmailClient;
    };

    const result = await pullForUser(userId, { gateways: ["mercado_pago"] }, { getClient });

    expect(result.errors.length).toBeGreaterThan(0);

    // pushToUser must NOT have been called for disambiguation — gated by errors.length === 0.
    const disambigCalls = mocks.pushToUser.mock.calls.filter(
      (args: unknown[]) => typeof args[1] === "string" && (args[1] as string).includes("ambig"),
    );
    expect(disambigCalls.length).toBe(0);
  });
});
