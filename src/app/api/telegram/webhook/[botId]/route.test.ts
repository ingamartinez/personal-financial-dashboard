import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramBots } from "@/lib/db/schema";
import { telegramCipher } from "@/lib/crypto/telegram-cipher";
import { POST } from "./route";

const TEST_USER_ID = 1;
const SECRET = "a".repeat(64);
const TOKEN = "1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

async function cleanup() {
  await db.delete(telegramBots).where(eq(telegramBots.userId, TEST_USER_ID));
}

async function seedBot(): Promise<number> {
  const [row] = await db
    .insert(telegramBots)
    .values({
      userId: TEST_USER_ID,
      tokenEncrypted: telegramCipher.encrypt(TOKEN),
      username: "vitest_bot",
      webhookSecret: SECRET,
    })
    .returning({ id: telegramBots.id });
  return row.id;
}

function request(
  botId: number | string,
  init: { headers?: Record<string, string>; body?: string } = {},
) {
  return new Request(`http://localhost:3100/api/telegram/webhook/${botId}`, {
    method: "POST",
    headers: init.headers,
    body: init.body,
  });
}

async function callPost(
  botId: number | string,
  init: { headers?: Record<string, string>; body?: string } = {},
) {
  return POST(request(botId, init), { params: Promise.resolve({ botId: String(botId) }) });
}

describe("POST /api/telegram/webhook/[botId]", () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
  });

  it("returns 401 when botId is not a positive integer", async () => {
    const res = await callPost("abc");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when botId matches no row", async () => {
    const res = await callPost(999_999);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the secret header is missing", async () => {
    const botId = await seedBot();
    const res = await callPost(botId, {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the secret header is wrong", async () => {
    const botId = await seedBot();
    const res = await callPost(botId, {
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const botId = await seedBot();
    const res = await callPost(botId, {
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad request" });
  });

  it("returns 200 for a valid empty Update (no message, no callback_query)", async () => {
    const botId = await seedBot();
    const res = await callPost(botId, {
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: JSON.stringify({ update_id: 42 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 200 but logs when the stored token ciphertext is corrupt", async () => {
    const botId = await seedBot();
    await db
      .update(telegramBots)
      .set({ tokenEncrypted: "not-a-valid-ciphertext" })
      .where(eq(telegramBots.id, botId));
    const res = await callPost(botId, {
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: JSON.stringify({ update_id: 42 }),
    });
    expect(res.status).toBe(200);
  });
});
