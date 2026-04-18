import { eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramSessions, type TelegramSessionState, type TelegramDraft } from "@/lib/db/schema";

const SESSION_TTL_MS = 30 * 60 * 1000;

export function emptyState(chatId: number, sourceMessageId?: number): TelegramSessionState {
  return {
    step: "idle",
    draft: {},
    sourceChatId: chatId,
    sourceMessageId,
  };
}

export async function getSession(chatId: number): Promise<TelegramSessionState | null> {
  const rows = await db
    .select()
    .from(telegramSessions)
    .where(eq(telegramSessions.chatId, BigInt(chatId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(telegramSessions).where(eq(telegramSessions.chatId, BigInt(chatId)));
    return null;
  }
  return row.state;
}

export async function upsertSession(opts: {
  chatId: number;
  userId: number;
  state: TelegramSessionState;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db
    .insert(telegramSessions)
    .values({
      chatId: BigInt(opts.chatId),
      userId: BigInt(opts.userId),
      state: opts.state,
      updatedAt: new Date(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: telegramSessions.chatId,
      set: {
        userId: BigInt(opts.userId),
        state: opts.state,
        updatedAt: new Date(),
        expiresAt,
      },
    });
}

export async function clearSession(chatId: number): Promise<void> {
  await db.delete(telegramSessions).where(eq(telegramSessions.chatId, BigInt(chatId)));
}

export async function sweepExpiredSessions(): Promise<number> {
  const result = await db
    .delete(telegramSessions)
    .where(lt(telegramSessions.expiresAt, new Date()))
    .returning({ chatId: telegramSessions.chatId });
  return result.length;
}

export function mergeDraft(
  state: TelegramSessionState,
  patch: Partial<TelegramDraft>,
): TelegramSessionState {
  return { ...state, draft: { ...state.draft, ...patch } };
}
