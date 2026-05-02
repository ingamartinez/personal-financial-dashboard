import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { emit as busEmit } from "@/lib/events/bus";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "notifications/emit" });

// canary_alert_fired is intentionally omitted: the canary system was removed (#593).
// Phase 4 emitters must NOT emit canary notifications until the canary system is
// rebuilt and a new sub-issue is opened.
export type NotificationType =
  | "gmail_token_expired"
  | "gmail_connected"
  | "gmail_pull_completed"
  | "gmail_disambiguation_required"
  | "gmail_source_mismatch"
  | "gmail_backfill_complete"
  | "statement_import_complete"
  | "reconciliation_flagged_txns"
  | "recurring_adjustment_pattern"
  | "rule_proposal_ready"
  | "recurring_gap_detected"
  | "sms_drift_detected"
  | "slo_alert_fired"
  | "reset_complete"
  | "snapshot_restored"
  | "insights_report_ready"
  | "budget_exceeded"
  | "invite_code_exhausted"
  | "classification_auto_uncategorized"
  | "recurring_proposal_ready"
  | "subscription_price_hike"
  | "tc_health_alert"
  // #713 (Epic I B.1+B.2): merchant anomaly and first-encounter signals.
  | "merchant_anomaly"
  | "merchant_first_encounter";

export type NotificationAudience = "user" | "admin";
export type NotificationPriority = "high" | "medium" | "low";

export interface EmitNotificationInput {
  type: NotificationType;
  // Required: dedup discriminator. Use String(rowId) for entity-scoped events, or a stable
  // synthetic string (e.g. "sms-drift-2026-04-25") for daily/period-scoped events. Never
  // null — Postgres NULLs are DISTINCT in unique indexes, which breaks idempotent emit.
  entityId: string;
  audience?: NotificationAudience; // default 'user'
  title: string;
  body: string;
  actionUrl?: string;
  priority?: NotificationPriority; // default 'medium'
  metadata?: Record<string, unknown>;
}

/**
 * Idempotently insert a notification and fire `notification:created` on the bus.
 *
 * Dedup is enforced via a partial unique index on (user_id, type, entity_id)
 * WHERE read_at IS NULL. Calling this twice for the same (user, type, entityId)
 * before the notification is read returns null on the second call and does NOT
 * fire a second bus event.
 *
 * Returns `{ id }` when the notification was inserted, or `null` when deduped.
 */
export async function emitNotification(
  userId: number,
  input: EmitNotificationInput,
): Promise<{ id: number } | null> {
  const inserted = await db
    .insert(notifications)
    .values({
      userId,
      type: input.type,
      entityId: input.entityId,
      audience: input.audience ?? "user",
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl ?? null,
      priority: input.priority ?? "medium",
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });

  if (inserted.length === 0) {
    log.debug(
      { userId, type: input.type, entityId: input.entityId, event: "notification_dedup" },
      "notification deduped",
    );
    return null;
  }

  const row = inserted[0]!;

  busEmit({
    type: "notification:created",
    userId,
    audience: input.audience ?? "user",
    notificationId: row.id,
    payload: {
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl,
      priority: input.priority ?? "medium",
      type: input.type,
      metadata: input.metadata,
    },
  });

  log.info(
    { userId, type: input.type, notificationId: row.id, event: "notification_created" },
    "notification created",
  );
  return { id: row.id };
}
