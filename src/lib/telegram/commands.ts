import type { TelegramClient } from "@/lib/telegram/client";
import { clearSession } from "@/lib/telegram/session";
import {
  renderCanceled,
  renderEnrichConnectPrompt,
  renderEnrichFailed,
  renderEnrichProcessing,
  renderEnrichResult,
  renderHelp,
  renderStart,
} from "@/lib/telegram/formatter";
import { pullForUser } from "@/lib/gmail/pull";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "telegram/commands" });

export type CommandName = "/start" | "/help" | "/cancel" | "/enriquecer";

// Maps aliases to canonical command names. `/enrich` is the English alias
// requested by #452. Add locale-specific aliases here; the canonical set
// above stays stable.
const COMMAND_ALIASES: Record<string, CommandName> = {
  "/start": "/start",
  "/help": "/help",
  "/cancel": "/cancel",
  "/enriquecer": "/enriquecer",
  "/enrich": "/enriquecer",
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
}): Promise<void> {
  const { command, chatId, client, userId } = opts;
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
