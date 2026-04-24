import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramBots, telegramSessions } from "@/lib/db/schema";
import { telegramCipher } from "@/lib/crypto/telegram-cipher";

const TEST_USER_ID = 1;
const VALID_TOKEN = "1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

// Mock module shared between tests. The factory must be synchronous so
// vi.hoisted is the right pattern for references from both the mock and
// the test bodies.
const { mockGetMe, mockSetWebhook, mockDeleteWebhook } = vi.hoisted(() => ({
  mockGetMe: vi.fn(),
  mockSetWebhook: vi.fn(),
  mockDeleteWebhook: vi.fn(),
}));

vi.mock("@/lib/telegram/client", () => ({
  createTelegramClient: () => ({
    getUpdates: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    answerCallbackQuery: vi.fn(),
    getFile: vi.fn(),
    downloadFile: vi.fn(),
    getMe: mockGetMe,
    setWebhook: mockSetWebhook,
    deleteWebhook: mockDeleteWebhook,
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => ({
    id: TEST_USER_ID,
    email: "test@findash.local",
    name: "Test User",
  }),
}));

// revalidatePath throws "static generation store missing" outside a Next.js
// request context — harmless no-op in tests.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

// Imported AFTER the mocks so they resolve to the stubs above.
const { registerBotAction, revokeBotAction } = await import("./actions");

async function cleanup() {
  await db.delete(telegramBots).where(eq(telegramBots.userId, TEST_USER_ID));
  await db.delete(telegramSessions).where(eq(telegramSessions.userId, TEST_USER_ID));
}

function formData(input: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(input)) fd.set(k, v);
  return fd;
}

describe("settings/telegram actions", () => {
  beforeAll(() => {
    process.env.AUTH_URL = "https://findash.test";
  });

  beforeEach(async () => {
    mockGetMe.mockReset();
    mockSetWebhook.mockReset();
    mockDeleteWebhook.mockReset();
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
  });

  describe("registerBotAction", () => {
    it("inserts the row and calls setWebhook on happy path", async () => {
      mockGetMe.mockResolvedValue({
        id: 99,
        is_bot: true,
        first_name: "Test",
        username: "happy_path_bot",
      });
      mockSetWebhook.mockResolvedValue(undefined);

      const result = await registerBotAction({ status: "idle" }, formData({ token: VALID_TOKEN }));

      expect(result).toEqual({ status: "success", username: "happy_path_bot" });

      const rows = await db
        .select()
        .from(telegramBots)
        .where(eq(telegramBots.userId, TEST_USER_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0].username).toBe("happy_path_bot");
      expect(rows[0].webhookSecret).toMatch(/^[0-9a-f]{64}$/);

      expect(mockSetWebhook).toHaveBeenCalledTimes(1);
      const call = mockSetWebhook.mock.calls[0][0] as { url: string; secretToken: string };
      expect(call.url).toBe(`https://findash.test/api/telegram/webhook/${rows[0].id}`);
      expect(call.secretToken).toBe(rows[0].webhookSecret);
    });

    it("rejects an invalid token format without touching Telegram", async () => {
      const result = await registerBotAction(
        { status: "idle" },
        formData({ token: "not-a-token" }),
      );
      expect(result.status).toBe("error");
      expect(mockGetMe).not.toHaveBeenCalled();
      expect(mockSetWebhook).not.toHaveBeenCalled();

      const rows = await db
        .select()
        .from(telegramBots)
        .where(eq(telegramBots.userId, TEST_USER_ID));
      expect(rows).toHaveLength(0);
    });

    it("returns an error when the user already has a bot", async () => {
      await db.insert(telegramBots).values({
        userId: TEST_USER_ID,
        tokenEncrypted: telegramCipher.encrypt(VALID_TOKEN),
        username: "existing_bot",
        webhookSecret: "a".repeat(64),
      });

      const result = await registerBotAction({ status: "idle" }, formData({ token: VALID_TOKEN }));
      expect(result.status).toBe("error");
      expect(mockGetMe).not.toHaveBeenCalled();
    });

    it("returns an error and inserts nothing when getMe fails", async () => {
      mockGetMe.mockRejectedValue(new Error("401 Unauthorized"));

      const result = await registerBotAction({ status: "idle" }, formData({ token: VALID_TOKEN }));
      expect(result.status).toBe("error");

      const rows = await db
        .select()
        .from(telegramBots)
        .where(eq(telegramBots.userId, TEST_USER_ID));
      expect(rows).toHaveLength(0);
      expect(mockSetWebhook).not.toHaveBeenCalled();
    });

    it("rolls back the row when setWebhook throws", async () => {
      mockGetMe.mockResolvedValue({
        id: 99,
        is_bot: true,
        first_name: "Test",
        username: "rollback_bot",
      });
      mockSetWebhook.mockRejectedValue(new Error("DNS lookup failed"));

      const result = await registerBotAction({ status: "idle" }, formData({ token: VALID_TOKEN }));
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/setWebhook failed/);
      }

      const rows = await db
        .select()
        .from(telegramBots)
        .where(eq(telegramBots.userId, TEST_USER_ID));
      expect(rows).toHaveLength(0);
    });
  });

  describe("revokeBotAction", () => {
    it("deletes the bot row + sessions and calls deleteWebhook", async () => {
      await db.insert(telegramBots).values({
        userId: TEST_USER_ID,
        tokenEncrypted: telegramCipher.encrypt(VALID_TOKEN),
        username: "to_revoke",
        webhookSecret: "b".repeat(64),
      });
      await db.insert(telegramSessions).values({
        chatId: BigInt(12345),
        userId: TEST_USER_ID,
        telegramUserId: BigInt(67890),
        state: { step: "idle", draft: {}, sourceChatId: 12345 },
        expiresAt: new Date(Date.now() + 60_000),
      });
      mockDeleteWebhook.mockResolvedValue(undefined);

      await revokeBotAction();

      const bots = await db
        .select()
        .from(telegramBots)
        .where(eq(telegramBots.userId, TEST_USER_ID));
      expect(bots).toHaveLength(0);
      const sessions = await db
        .select()
        .from(telegramSessions)
        .where(eq(telegramSessions.userId, TEST_USER_ID));
      expect(sessions).toHaveLength(0);
      expect(mockDeleteWebhook).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no bot exists", async () => {
      await expect(revokeBotAction()).resolves.toBeUndefined();
      expect(mockDeleteWebhook).not.toHaveBeenCalled();
    });

    it("still deletes the local row when deleteWebhook throws", async () => {
      await db.insert(telegramBots).values({
        userId: TEST_USER_ID,
        tokenEncrypted: telegramCipher.encrypt(VALID_TOKEN),
        username: "tg_down",
        webhookSecret: "c".repeat(64),
      });
      mockDeleteWebhook.mockRejectedValue(new Error("502 Bad Gateway from Telegram"));

      await revokeBotAction();

      const bots = await db
        .select()
        .from(telegramBots)
        .where(eq(telegramBots.userId, TEST_USER_ID));
      expect(bots).toHaveLength(0);
      expect(mockDeleteWebhook).toHaveBeenCalledTimes(1);
    });
  });
});
