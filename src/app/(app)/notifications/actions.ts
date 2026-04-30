"use server";

import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import type { ListNotificationsInput, ListNotificationsResult, NotificationRow } from "./_types";

const listSchema = z.object({
  unreadOnly: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.number().int().positive().optional(),
});

export async function listNotifications(
  input: ListNotificationsInput = {},
): Promise<ListNotificationsResult> {
  const session = await getSessionUser();
  const { unreadOnly, limit, cursor } = listSchema.parse(input);

  const conditions = [eq(notifications.userId, session.id)];

  if (unreadOnly) {
    conditions.push(isNull(notifications.readAt));
  }

  if (cursor !== undefined) {
    // Cursor-based pagination: descending by createdAt then id.
    // Cursor is the id of the last item from the previous page.
    // We use a subquery approach: items with id < cursor (since we're
    // ordering descending by createdAt, we need to page by id when
    // createdAt values can tie).
    conditions.push(lt(notifications.id, cursor));
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1);

  // Determine if there is a next page.
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

  return {
    items: items.map(
      (row): NotificationRow => ({
        id: row.id,
        type: row.type,
        entityId: row.entityId,
        audience: row.audience,
        title: row.title,
        body: row.body,
        actionUrl: row.actionUrl,
        priority: row.priority,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        readAt: row.readAt,
        createdAt: row.createdAt,
      }),
    ),
    nextCursor,
  };
}

export async function markAsRead(
  id: number,
): Promise<{ ok: true } | { ok: false; reason: "not-found" }> {
  const session = await getSessionUser();

  const updated = await db
    .update(notifications)
    .set({ readAt: sql`NOW()` })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.userId, session.id),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });

  if (updated.length === 0) {
    // Either not found or already read — check existence to distinguish.
    const existing = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, session.id)))
      .limit(1);

    if (existing.length === 0) {
      return { ok: false, reason: "not-found" };
    }
    // Already read — treat as success (idempotent).
    return { ok: true };
  }

  return { ok: true };
}

export async function markAllAsRead(): Promise<{ count: number }> {
  const session = await getSessionUser();

  const updated = await db
    .update(notifications)
    .set({ readAt: sql`NOW()` })
    .where(and(eq(notifications.userId, session.id), isNull(notifications.readAt)))
    .returning({ id: notifications.id });

  return { count: updated.length };
}

export async function unreadCount(): Promise<{ count: number }> {
  const session = await getSessionUser();

  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, session.id), isNull(notifications.readAt)));

  return { count: result?.count ?? 0 };
}
