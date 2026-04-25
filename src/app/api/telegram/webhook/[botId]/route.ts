import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { canIngest, paywallResponse } from "@/lib/auth/can-ingest";
import { db } from "@/lib/db";
import { telegramBots, telegramSessions } from "@/lib/db/schema";
import { telegramCipher } from "@/lib/crypto/telegram-cipher";
import { createLogger } from "@/lib/logger";
import { createTelegramClient } from "@/lib/telegram/client";
import { handleUpdate, type RouterDeps } from "@/lib/telegram/router";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { listAccountsDetailed } from "@/lib/accounts/queries";
import { listCategories } from "@/lib/transactions/queries";
import { parseTransactionMessage } from "@/lib/ai/transaction-nlu";
import { extractTransactionsFromImage } from "@/lib/ingestion/ocr";
import { transcribeAudio } from "@/lib/stt/transcribe";
import { parseCommand } from "@/lib/telegram/commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const log = createLogger({ module: "api/telegram/webhook" });

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: Request, { params }: { params: Promise<{ botId: string }> }) {
  const { botId: botIdRaw } = await params;
  const botId = Number.parseInt(botIdRaw, 10);
  if (!Number.isInteger(botId) || botId <= 0) return unauthorized();

  const rows = await db.select().from(telegramBots).where(eq(telegramBots.id, botId)).limit(1);
  const bot = rows[0];
  if (!bot) return unauthorized();

  const provided = req.headers.get(SECRET_HEADER);
  if (!provided || !constantTimeEquals(provided, bot.webhookSecret)) {
    return unauthorized();
  }

  // Parse the incoming update early so we can decide whether to apply the
  // paywall. Disambiguation commands (/revisar, /omitir) and replies to an
  // awaiting_disambiguation session are housekeeping on already-ingested data
  // — they must work even when the user hits the ingest limit.
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Check whether this update is exempt from the paywall:
  // 1. The command is /revisar or /omitir (explicit disambiguation housekeeping).
  // 2. The user has an active awaiting_disambiguation session (reply intercept).
  const isPaywallExempt = await checkDisambiguationExempt(bot.userId, update);

  if (!isPaywallExempt) {
    const gate = await canIngest(bot.userId);
    if (!gate.allowed) return paywallResponse(gate.reason);
  }

  let token: string;
  try {
    token = telegramCipher.decrypt(bot.tokenEncrypted);
  } catch (err) {
    // Ciphertext corrupt or encryption key rotated. Log + 200: Telegram
    // retrying won't help until the bot is re-registered.
    log.error({ err, botId, event: "telegram_token_decrypt_failed" }, "failed to decrypt token");
    return NextResponse.json({ ok: true });
  }

  const client = createTelegramClient({ token });
  const deps: RouterDeps = {
    userId: bot.userId,
    listAccounts: () => listAccountsDetailed(bot.userId),
    listCategories: () => listCategories(bot.userId),
    parseNlu: (p) => parseTransactionMessage({ text: p.text, context: p.context }),
    runOcr: (p) => extractTransactionsFromImage(p),
    transcribeVoice: (p) => transcribeAudio(p),
  };

  try {
    await handleUpdate(update, client, deps);
  } catch (err) {
    // Telegram retries on non-2xx, which would pile up broken updates.
    // Swallow downstream errors and return 200; the error is logged for ops.
    log.error({ err, botId, event: "telegram_handler_threw" }, "handler threw");
  }

  return NextResponse.json({ ok: true });
}

/**
 * Returns true if this Telegram update should bypass the paywall.
 *
 * Exempt cases (#456):
 * - The message is a /revisar or /omitir command.
 * - The user's most recent session is awaiting_disambiguation (reply intercept).
 */
async function checkDisambiguationExempt(userId: number, update: TelegramUpdate): Promise<boolean> {
  const msgText = update.message?.text;
  if (msgText) {
    const cmd = parseCommand(msgText);
    if (cmd === "/revisar" || cmd === "/omitir") return true;
  }

  // Check if there's an awaiting_disambiguation session for this user.
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (typeof chatId === "number") {
    const [session] = await db
      .select({ state: telegramSessions.state })
      .from(telegramSessions)
      .where(eq(telegramSessions.chatId, BigInt(chatId)))
      .limit(1);
    if (session?.state?.step === "awaiting_disambiguation") return true;
  }

  return false;
}
