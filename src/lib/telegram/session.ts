import { desc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramSessions, type TelegramSessionState, type TelegramDraft } from "@/lib/db/schema";

const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * telegram_sessions holds two things with different lifetimes:
 *   - Channel: chatId + telegramUserId. How we reach this user. Persists.
 *   - Conversation: state.step + expiresAt. The live lock. Expires / clears.
 *
 * Ending a conversation MUST release step to idle, never DELETE the row.
 * Deleting drops the channel; the next classify-ask / disambiguation /
 * re-auth nudge then dies on no_channel with every test still green.
 */
export function emptyState(chatId: number, sourceMessageId?: number): TelegramSessionState {
  return {
    step: "idle",
    draft: {},
    sourceChatId: chatId,
    sourceMessageId,
  };
}

function isLiveConversation(row: { state: TelegramSessionState; expiresAt: Date }): boolean {
  return row.state.step !== "idle" && row.expiresAt.getTime() >= Date.now();
}

async function releaseConversation(chatId: number): Promise<void> {
  await db
    .update(telegramSessions)
    .set({
      state: emptyState(chatId),
      updatedAt: new Date(),
    })
    .where(eq(telegramSessions.chatId, BigInt(chatId)));
}

export async function getSession(chatId: number): Promise<TelegramSessionState | null> {
  const rows = await db
    .select()
    .from(telegramSessions)
    .where(eq(telegramSessions.chatId, BigInt(chatId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!isLiveConversation(row)) {
    if (row.state.step !== "idle") {
      await releaseConversation(chatId);
    }
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
 * Most recent Telegram channel for a user, across all chats.
 * Used by push triggers that need a chatId. Returns null only when we
 * have never seen this user on Telegram — an expired or cleared
 * conversation still returns the channel, with step idle.
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
      expiresAt: telegramSessions.expiresAt,
    })
    .from(telegramSessions)
    .where(eq(telegramSessions.userId, userId))
    .orderBy(desc(telegramSessions.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!isLiveConversation(row) && row.state.step !== "idle") {
    const chatId = Number(row.chatId);
    await releaseConversation(chatId);
    return {
      chatId: row.chatId,
      telegramUserId: row.telegramUserId,
      state: emptyState(chatId),
    };
  }
  return { chatId: row.chatId, telegramUserId: row.telegramUserId, state: row.state };
}

/** End the live conversation. Keep the channel so the next push can reach the user. */
export async function clearSession(chatId: number): Promise<void> {
  await releaseConversation(chatId);
}

export async function sweepExpiredSessions(): Promise<number> {
  const rows = await db
    .select({
      chatId: telegramSessions.chatId,
      state: telegramSessions.state,
    })
    .from(telegramSessions)
    .where(lt(telegramSessions.expiresAt, new Date()));
  let released = 0;
  for (const row of rows) {
    if (row.state.step === "idle") continue;
    await releaseConversation(Number(row.chatId));
    released++;
  }
  return released;
}

export function mergeDraft(
  state: TelegramSessionState,
  patch: Partial<TelegramDraft>,
): TelegramSessionState {
  return { ...state, draft: { ...state.draft, ...patch } };
}
