import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramBots } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { TelegramBotManager } from "./telegram-bot-manager";

export const dynamic = "force-dynamic";

export default async function TelegramSettingsPage() {
  const session = await getSessionUser();
  const [bot] = await db
    .select({
      id: telegramBots.id,
      username: telegramBots.username,
      createdAt: telegramBots.createdAt,
    })
    .from(telegramBots)
    .where(eq(telegramBots.userId, session.id))
    .limit(1);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Telegram bot</h1>
        <p className="text-body text-muted-foreground">
          Register your personal Telegram bot to log transactions by message, voice, or photo. Each
          Findash user has exactly one bot; the BotFather token is stored AES-256-GCM encrypted and
          Telegram posts updates to{" "}
          <code className="font-mono">/api/telegram/webhook/&lt;botId&gt;</code>.
        </p>
      </header>
      <TelegramBotManager
        bot={
          bot
            ? {
                id: bot.id,
                username: bot.username,
                createdAt: bot.createdAt.toISOString(),
              }
            : null
        }
      />
    </main>
  );
}
