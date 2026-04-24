import type { TelegramClient } from "@/lib/telegram/client";
import type { TelegramSessionState } from "@/lib/db/schema";
import { clearSession, getSession, upsertSession } from "@/lib/telegram/session";
import {
  renderBackfillConfirmPrompt,
  renderBackfillConnectPrompt,
  renderBackfillFailed,
  renderBackfillNothingPending,
  renderBackfillProgress,
  renderBackfillResult,
  renderBackfillStarting,
  renderCanceled,
  renderEnrichConnectPrompt,
  renderEnrichFailed,
  renderEnrichProcessing,
  renderEnrichResult,
  renderHelp,
  renderStart,
} from "@/lib/telegram/formatter";
import { pullForUser } from "@/lib/gmail/pull";
import {
  backfillBancolombia,
  backfillBancolombiaDryRun,
  BackfillConnectionError,
} from "@/lib/gmail/backfill";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "telegram/commands" });

export type CommandName = "/start" | "/help" | "/cancel" | "/enriquecer" | "/backfill" | "/si";

// Maps aliases to canonical command names. `/enrich` is the English alias
// requested by #452. `/backfill-gmail` maps to the canonical `/backfill`.
// `/sí`, `/yes` map to `/si` for confirmation flows (#458).
const COMMAND_ALIASES: Record<string, CommandName> = {
  "/start": "/start",
  "/help": "/help",
  "/cancel": "/cancel",
  "/enriquecer": "/enriquecer",
  "/enrich": "/enriquecer",
  "/backfill": "/backfill",
  "/backfill-gmail": "/backfill",
  "/si": "/si",
  "/sí": "/si",
  "/yes": "/si",
};

export function parseCommand(text: string): CommandName | null {
  const trimmed = text.trim().toLowerCase().split(/\s+/)[0];
  const base = trimmed?.split("@")[0] ?? "";
  return COMMAND_ALIASES[base] ?? null;
}

export async function handleCommand(opts: {
  command: CommandName;
  chatId: number;
  client: TelegramClient;
  userId: number;
  telegramUserId: number;
  text: string;
}): Promise<void> {
  const { command, chatId, client, userId, telegramUserId, text } = opts;
  switch (command) {
    case "/start":
      await client.sendMessage({ chat_id: chatId, text: renderStart(), parse_mode: "Markdown" });
      return;
    case "/help":
      await client.sendMessage({ chat_id: chatId, text: renderHelp(), parse_mode: "Markdown" });
      return;
    case "/cancel":
      await clearSession(chatId);
      await client.sendMessage({ chat_id: chatId, text: renderCanceled() });
      return;
    case "/enriquecer":
      await handleEnriquecer({ chatId, client, userId });
      return;
    case "/backfill":
      await handleBackfill({ chatId, client, userId, telegramUserId, text });
      return;
    case "/si":
      await handleBackfillConfirm({ chatId, client, userId, telegramUserId });
      return;
  }
}

async function handleEnriquecer(opts: {
  chatId: number;
  client: TelegramClient;
  userId: number;
}): Promise<void> {
  const { chatId, client, userId } = opts;
  // Acknowledge first — the Gmail pull can take multiple seconds on a cold
  // inbox, and Telegram clients show no progress otherwise.
  await client.sendMessage({ chat_id: chatId, text: renderEnrichProcessing() });

  try {
    const result = await pullForUser(userId);
    if (result.connectionId === null) {
      await client.sendMessage({
        chat_id: chatId,
        text: renderEnrichConnectPrompt(),
        parse_mode: "Markdown",
      });
      return;
    }
    await client.sendMessage({ chat_id: chatId, text: renderEnrichResult(result) });
  } catch (err) {
    log.error({ err, userId, event: "telegram_enriquecer_failed" }, "/enriquecer threw");
    await client.sendMessage({ chat_id: chatId, text: renderEnrichFailed() });
  }
}

// Parses the optional `[year]` argument from `/backfill-gmail 2025` style
// input. Rejects anything outside a sensible range so a typo doesn't trigger
// a quota-exhausting 10-year scan.
function parseBackfillYear(text: string, now: Date): number | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return now.getUTCFullYear();
  const year = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(year)) return null;
  const currentYear = now.getUTCFullYear();
  if (year < 2020 || year > currentYear) return null;
  return year;
}

async function handleBackfill(opts: {
  chatId: number;
  client: TelegramClient;
  userId: number;
  telegramUserId: number;
  text: string;
}): Promise<void> {
  const { chatId, client, userId, telegramUserId, text } = opts;
  const now = new Date();
  const year = parseBackfillYear(text, now);
  if (year === null) {
    await client.sendMessage({
      chat_id: chatId,
      text: "⚠️ Año inválido. Usá `/backfill-gmail` (año actual) o `/backfill-gmail 2025`.",
      parse_mode: "Markdown",
    });
    return;
  }

  // `before:` is exclusive at midnight UTC, so passing Jan 1 of the next
  // year covers through Dec 31. When backfilling the current year we stop
  // at tomorrow UTC to cover today's messages.
  const from = new Date(Date.UTC(year, 0, 1));
  const isCurrentYear = year === now.getUTCFullYear();
  const to = isCurrentYear
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(year + 1, 0, 1));

  await client.sendMessage({
    chat_id: chatId,
    text: `📧 Revisando emails de Bancolombia ${year}…`,
  });

  let preview;
  try {
    preview = await backfillBancolombiaDryRun(userId, { from, to });
  } catch (err) {
    if (err instanceof BackfillConnectionError) {
      await client.sendMessage({
        chat_id: chatId,
        text: renderBackfillConnectPrompt(err.reason),
        parse_mode: "Markdown",
      });
      return;
    }
    log.error({ err, userId, year, event: "telegram_backfill_dryrun_failed" }, "dry-run threw");
    await client.sendMessage({ chat_id: chatId, text: renderBackfillFailed() });
    return;
  }

  const state: TelegramSessionState = {
    step: "awaiting_backfill_confirm",
    draft: {},
    sourceChatId: chatId,
    backfill: {
      from: from.toISOString(),
      to: to.toISOString(),
      gateway: "bancolombia",
    },
  };
  await upsertSession({ chatId, userId, telegramUserId, state });

  await client.sendMessage({
    chat_id: chatId,
    text: renderBackfillConfirmPrompt({ year, preview }),
    parse_mode: "Markdown",
  });
}

async function handleBackfillConfirm(opts: {
  chatId: number;
  client: TelegramClient;
  userId: number;
  telegramUserId: number;
}): Promise<void> {
  const { chatId, client, userId, telegramUserId } = opts;
  const session = await getSession(chatId);
  if (!session) {
    await client.sendMessage({ chat_id: chatId, text: renderBackfillNothingPending() });
    return;
  }
  if (session.step === "backfill_running") {
    await client.sendMessage({
      chat_id: chatId,
      text: "⏳ Ya hay un backfill corriendo. Esperá a que termine o usá /cancel para abortar.",
    });
    return;
  }
  if (session.step !== "awaiting_backfill_confirm" || !session.backfill) {
    await client.sendMessage({ chat_id: chatId, text: renderBackfillNothingPending() });
    return;
  }

  const from = new Date(session.backfill.from);
  const to = new Date(session.backfill.to);

  // Atomic transition: any subsequent /si arrives, reads backfill_running,
  // and bails. A /cancel deletes the session row so the loop's shouldCancel
  // poll returns true.
  await upsertSession({
    chatId,
    userId,
    telegramUserId,
    state: { ...session, step: "backfill_running" },
  });

  await client.sendMessage({ chat_id: chatId, text: renderBackfillStarting() });

  try {
    const report = await backfillBancolombia(userId, {
      from,
      to,
      shouldCancel: async () => {
        const s = await getSession(chatId);
        return !s || s.step !== "backfill_running";
      },
      onProgress: async ({ phase, processed, total }) => {
        if (phase !== "fetching") return;
        await client.sendMessage({
          chat_id: chatId,
          text: renderBackfillProgress({ processed, total }),
        });
      },
    });
    await client.sendMessage({ chat_id: chatId, text: renderBackfillResult(report) });
  } catch (err) {
    if (err instanceof BackfillConnectionError) {
      await client.sendMessage({
        chat_id: chatId,
        text: renderBackfillConnectPrompt(err.reason),
        parse_mode: "Markdown",
      });
      return;
    }
    log.error({ err, userId, event: "telegram_backfill_failed" }, "backfill threw");
    await client.sendMessage({ chat_id: chatId, text: renderBackfillFailed() });
  } finally {
    // Always clear the session at the end — successful, errored, or canceled.
    // A /cancel mid-flight has already deleted it; clearSession is idempotent.
    await clearSession(chatId);
  }
}
