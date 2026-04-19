"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { telegramBots, telegramSessions } from "@/lib/db/schema";
import { decrypt, encrypt } from "@/lib/crypto/symmetric";
import { getSessionUser } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";
import { createTelegramClient } from "@/lib/telegram/client";

const log = createLogger({ module: "settings/telegram/actions" });

const BOT_TOKEN_REGEX = /^\d{8,12}:[A-Za-z0-9_-]{30,}$/;

const registerSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(BOT_TOKEN_REGEX, "Invalid BotFather token format (expected <digits>:<base62_-_>)."),
});

export type RegisterActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; username: string };

function resolveWebhookBaseUrl(): string {
  const url = process.env.AUTH_URL?.trim();
  if (!url) {
    throw new Error(
      "AUTH_URL must be set to register a Telegram webhook (Telegram requires HTTPS public URL).",
    );
  }
  return url.replace(/\/+$/, "");
}

export async function registerBotAction(
  _prev: RegisterActionState,
  formData: FormData,
): Promise<RegisterActionState> {
  const session = await getSessionUser();

  const parsed = registerSchema.safeParse({ token: formData.get("token") });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const token = parsed.data.token;

  const existing = await db
    .select({ id: telegramBots.id })
    .from(telegramBots)
    .where(eq(telegramBots.userId, session.id))
    .limit(1);
  if (existing.length > 0) {
    return {
      status: "error",
      message: "You already have a bot registered. Delete it first to register a new one.",
    };
  }

  let baseUrl: string;
  try {
    baseUrl = resolveWebhookBaseUrl();
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "Missing AUTH_URL." };
  }

  const client = createTelegramClient({ token });

  let username: string;
  try {
    const me = await client.getMe();
    username = me.username;
  } catch (err) {
    return {
      status: "error",
      message: `Telegram rejected the token: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  const webhookSecret = randomBytes(32).toString("hex");

  // Insert first to obtain the serial id that the webhook URL embeds, then
  // setWebhook. If Telegram rejects the URL (DNS, unreachable, bad TLS),
  // delete the row so the UI goes back to the empty state.
  const [row] = await db
    .insert(telegramBots)
    .values({
      userId: session.id,
      tokenEncrypted: encrypt(token),
      username,
      webhookSecret,
    })
    .returning({ id: telegramBots.id });

  try {
    await client.setWebhook({
      url: `${baseUrl}/api/telegram/webhook/${row.id}`,
      secretToken: webhookSecret,
    });
  } catch (err) {
    await db.delete(telegramBots).where(eq(telegramBots.id, row.id));
    return {
      status: "error",
      message: `setWebhook failed: ${err instanceof Error ? err.message : "unknown"}. Row rolled back.`,
    };
  }

  revalidatePath("/settings/telegram");
  return { status: "success", username };
}

export async function revokeBotAction(): Promise<void> {
  const session = await getSessionUser();

  const [bot] = await db
    .select()
    .from(telegramBots)
    .where(eq(telegramBots.userId, session.id))
    .limit(1);
  if (!bot) {
    revalidatePath("/settings/telegram");
    return;
  }

  let token: string | null = null;
  try {
    token = decrypt(bot.tokenEncrypted);
  } catch (err) {
    log.error(
      { err, event: "telegram_revoke_decrypt_failed" },
      "decrypt failed — deleting row without Telegram call",
    );
  }

  if (token) {
    try {
      await createTelegramClient({ token }).deleteWebhook();
    } catch (err) {
      log.error(
        { err, event: "telegram_revoke_delete_webhook_failed" },
        "deleteWebhook failed — continuing with local delete anyway",
      );
    }
  }

  await db.delete(telegramBots).where(eq(telegramBots.id, bot.id));
  // Chat sessions are keyed by chat_id but scoped to this user_id — they
  // reference state that only this bot could produce. Sweeping avoids stale
  // rows pointing at a deleted bot.
  await db.delete(telegramSessions).where(eq(telegramSessions.userId, session.id));

  revalidatePath("/settings/telegram");
}
