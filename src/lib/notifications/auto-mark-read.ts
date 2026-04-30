import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { subscribe, type AppEvent } from "@/lib/events/bus";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "notifications/auto-mark-read" });

// Bus events that resolve a previously-emitted notification. Adding a new entry
// here is the only place to wire a new auto-mark-read mapping.
//
// canary:resolved is intentionally absent — the canary system was removed (#593)
// and canary_alert_fired notifications are not part of NotificationType.
const RESOLUTION_MAP: Record<
  string,
  { notificationType: string; getEntityId: (event: AppEvent) => string | null }
> = {
  "recurring-gap:resolved": {
    notificationType: "recurring_gap_detected",
    getEntityId: (event) => {
      // gapId is null for synthetic auto-links — no notification ever existed, no-op
      if (event.type !== "recurring-gap:resolved") return null;
      return event.gapId === null ? null : String(event.gapId);
    },
  },
  "gmail:reconnected": {
    notificationType: "gmail_token_expired",
    getEntityId: (event) =>
      event.type === "gmail:reconnected" ? String(event.connectionId) : null,
  },
  "slo:resolved": {
    notificationType: "slo_alert_fired",
    getEntityId: (event) => (event.type === "slo:resolved" ? String(event.alertId) : null),
  },
  "disambiguation:resolved": {
    notificationType: "gmail_disambiguation_required",
    getEntityId: (event) =>
      event.type === "disambiguation:resolved" ? String(event.receiptId) : null,
  },
};

/**
 * Registers a bus subscriber that auto-marks notifications as read when
 * their underlying event resolves through another channel.
 *
 * INVARIANT: this listener NEVER emits `notification:created`. It only
 * mutates `read_at` directly via drizzle. Only `emit.ts` fires bus events.
 *
 * Returns the unsubscribe function.
 */
export function registerAutoMarkRead(): () => void {
  const unsubscribe = subscribe(async (event) => {
    const handler = RESOLUTION_MAP[event.type];
    if (!handler) return;

    const entityId = handler.getEntityId(event);
    if (entityId === null) {
      log.debug(
        { eventType: event.type, userId: event.userId, event: "auto_mark_read_skip" },
        "no entity id — skipping auto-mark-read",
      );
      return;
    }

    try {
      const result = await db
        .update(notifications)
        .set({ readAt: sql`NOW()` })
        .where(
          and(
            eq(notifications.userId, event.userId),
            eq(notifications.type, handler.notificationType),
            eq(notifications.entityId, entityId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });

      if (result.length > 0) {
        log.info(
          {
            userId: event.userId,
            eventType: event.type,
            notificationType: handler.notificationType,
            entityId,
            markedCount: result.length,
            event: "auto_mark_read_applied",
          },
          "auto-marked notification as read",
        );
      }
    } catch (err) {
      log.error(
        {
          err,
          userId: event.userId,
          eventType: event.type,
          entityId,
          event: "auto_mark_read_failed",
        },
        "failed to auto-mark notification as read",
      );
    }
  });

  log.info({ event: "auto_mark_read_registered" }, "auto-mark-read listener registered");
  return unsubscribe;
}
