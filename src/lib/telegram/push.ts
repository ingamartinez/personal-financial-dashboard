import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramBots, telegramSessions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { telegramCipher } from "@/lib/crypto/telegram-cipher";
import { createTelegramClient } from "@/lib/telegram/client";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "telegram/push" });

export type PushResult =
  | { ok: true }
  | { ok: false; reason: "no_bot" | "no_session" | "token_decrypt_failed" | "send_failed" };

/**
 * Push a Telegram message to a user's most recent active chat.
 *
 * Pattern mirrors canary-alerts.ts: look up telegram_bots by userId, then
 * the most recent telegram_sessions row for chatId, then send.
 *
 * Returns `{ ok: false, reason }` when delivery cannot proceed silently.
 * Callers should log the reason if relevant but MUST NOT throw.
 */
export async function pushToUser(
  userId: number,
  text: string,
  parseMode?: "Markdown" | "HTML",
): Promise<PushResult> {
  const [bot] = await db
    .select()
    .from(telegramBots)
    .where(and(eq(telegramBots.userId, userId), notDeleted(telegramBots.deletedAt)))
    .limit(1);
  if (!bot) return { ok: false, reason: "no_bot" };

  const [session] = await db
    .select({ chatId: telegramSessions.chatId })
    .from(telegramSessions)
    .where(eq(telegramSessions.userId, userId))
    .orderBy(desc(telegramSessions.updatedAt))
    .limit(1);
  if (!session) return { ok: false, reason: "no_session" };

  let token: string;
  try {
    token = telegramCipher.decrypt(bot.tokenEncrypted);
  } catch {
    return { ok: false, reason: "token_decrypt_failed" };
  }

  const client = createTelegramClient({ token });
  try {
    await client.sendMessage({
      chat_id: Number(session.chatId),
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    });
    return { ok: true };
  } catch (err) {
    log.error({ err, userId, event: "push_to_user_failed" }, "failed to push Telegram message");
    return { ok: false, reason: "send_failed" };
  }
}
