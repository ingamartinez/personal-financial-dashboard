import type { TelegramClient } from "@/lib/telegram/client";
import { clearSession } from "@/lib/telegram/session";
import { renderCanceled, renderHelp, renderStart } from "@/lib/telegram/formatter";

export type CommandName = "/start" | "/help" | "/cancel";

export function parseCommand(text: string): CommandName | null {
  const trimmed = text.trim().toLowerCase().split(/\s+/)[0];
  const base = trimmed?.split("@")[0] ?? "";
  if (base === "/start" || base === "/help" || base === "/cancel") return base;
  return null;
}

export async function handleCommand(opts: {
  command: CommandName;
  chatId: number;
  client: TelegramClient;
}): Promise<void> {
  const { command, chatId, client } = opts;
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
  }
}
