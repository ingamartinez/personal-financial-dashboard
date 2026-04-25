import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramBots, telegramSessions, users } from "@/lib/db/schema";
import { telegramCipher } from "@/lib/crypto/telegram-cipher";

const TAG = "PUSH_TEST";

// We mock the telegram client to avoid real HTTP calls. The mock is hoisted
// so the factory can be shared across `vi.mock` and the test body.
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/telegram/client", () => ({
  createTelegramClient: () => ({
    sendMessage: mocks.sendMessage,
  }),
}));

let userId: number;

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

async function seedBot(uid: number): Promise<void> {
  await db.insert(telegramBots).values({
    userId: uid,
    tokenEncrypted: telegramCipher.encrypt("fake-token"),
    username: `bot_${uid}`,
    webhookSecret: "secret",
  });
}

async function seedSession(uid: number, chatId: number): Promise<void> {
  await db.insert(telegramSessions).values({
    chatId: BigInt(chatId),
    userId: uid,
    telegramUserId: BigInt(9000),
    state: { step: "idle", draft: {}, sourceChatId: chatId },
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
}

beforeAll(async () => {
  await cleanup();
  userId = await createUser("push");
});

afterAll(cleanup);

beforeEach(async () => {
  await db.delete(telegramBots).where(sql`username LIKE ${"bot_" + "%"}`);
  await db.delete(telegramSessions).where(sql`user_id = ${userId}`);
  mocks.sendMessage.mockClear();
});

// Import after mocks are set up.
const { pushToUser } = await import("./push");

describe("pushToUser", () => {
  it("returns no_bot when user has no Telegram bot", async () => {
    const result = await pushToUser(userId, "hello");
    expect(result).toEqual({ ok: false, reason: "no_bot" });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("returns no_session when bot exists but no session row", async () => {
    await seedBot(userId);
    const result = await pushToUser(userId, "hello");
    expect(result).toEqual({ ok: false, reason: "no_session" });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("sends the message and returns ok when bot + session exist", async () => {
    await seedBot(userId);
    await seedSession(userId, 777);
    const result = await pushToUser(userId, "¡Hola!");
    expect(result).toEqual({ ok: true });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 777, text: "¡Hola!" }),
    );
  });

  it("passes parse_mode when provided", async () => {
    await seedBot(userId);
    await seedSession(userId, 778);
    await pushToUser(userId, "*bold*", "Markdown");
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ parse_mode: "Markdown" }),
    );
  });

  it("returns send_failed when client throws", async () => {
    await seedBot(userId);
    await seedSession(userId, 779);
    mocks.sendMessage.mockRejectedValueOnce(new Error("Telegram 429"));
    const result = await pushToUser(userId, "test");
    expect(result).toEqual({ ok: false, reason: "send_failed" });
  });
});
