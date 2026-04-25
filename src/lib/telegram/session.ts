import { desc, eq, lt } from "drizzle-orm";
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
  telegramUserId: number;
  state: TelegramSessionState;
  /** Override the session TTL. Defaults to SESSION_TTL_MS (30min). */
  ttlMs?: number;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? SESSION_TTL_MS));
  await db
    .insert(telegramSessions)
    .values({
      userId: opts.userId,
      chatId: BigInt(opts.chatId),
      telegramUserId: BigInt(opts.telegramUserId),
      state: opts.state,
      updatedAt: new Date(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: telegramSessions.chatId,
      set: {
        userId: opts.userId,
        telegramUserId: BigInt(opts.telegramUserId),
        state: opts.state,
        updatedAt: new Date(),
        expiresAt,
      },
    });
}

/**
 * Get the most recent active session for a user, across all chats.
 * Used by push triggers that need to know a user's current chatId.
 * Returns null if no active session exists.
 */
export async function getLatestSessionByUserId(userId: number): Promise<{
  chatId: bigint;
  telegramUserId: bigint;
  state: TelegramSessionState;
} | null> {
  const rows = await db
    .select({
      chatId: telegramSessions.chatId,
      telegramUserId: telegramSessions.telegramUserId,
      state: telegramSessions.state,
    })
    .from(telegramSessions)
    .where(eq(telegramSessions.userId, userId))
    .orderBy(desc(telegramSessions.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { chatId: row.chatId, telegramUserId: row.telegramUserId, state: row.state };
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
