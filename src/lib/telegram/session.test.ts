import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramSessions, users } from "@/lib/db/schema";
import { clearSession, getLatestSessionByUserId, getSession, upsertSession } from "./session";

const TAG = "TG_SESSION_TEST";

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

async function createUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `${TAG}-${Date.now()}-${Math.random()}@test.local`,
      name: TAG,
    })
    .returning({ id: users.id });
  return row.id;
}

describe("telegram session channel vs conversation", () => {
  let userId: number;
  let chatId: number;

  beforeAll(cleanup);
  afterAll(cleanup);

  afterEach(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  async function setup() {
    userId = await createUser();
    chatId = 9_300_000 + userId;
    await upsertSession({
      chatId,
      userId,
      telegramUserId: 9_400_000 + userId,
      state: {
        step: "awaiting_classification",
        draft: {},
        sourceChatId: chatId,
        classificationTxId: 1106,
      },
      ttlMs: 24 * 60 * 60 * 1000,
    });
  }

  it("clearSession keeps the channel so the next push can still find the user", async () => {
    await setup();
    await clearSession(chatId);

    expect(await getSession(chatId)).toBeNull();
    const channel = await getLatestSessionByUserId(userId);
    expect(channel).not.toBeNull();
    expect(Number(channel!.chatId)).toBe(chatId);
    expect(channel!.state.step).toBe("idle");

    const [row] = await db
      .select({ chatId: telegramSessions.chatId })
      .from(telegramSessions)
      .where(eq(telegramSessions.userId, userId));
    expect(Number(row?.chatId)).toBe(chatId);
  });

  it("an expired awaiting_classification lock is released without dropping the channel", async () => {
    await setup();
    await db
      .update(telegramSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(telegramSessions.userId, userId));

    expect(await getSession(chatId)).toBeNull();

    const channel = await getLatestSessionByUserId(userId);
    expect(channel).not.toBeNull();
    expect(Number(channel!.chatId)).toBe(chatId);
    expect(channel!.state.step).toBe("idle");
  });
});
