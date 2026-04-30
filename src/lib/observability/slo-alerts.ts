import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { parserEvents, sloAlerts, telegramBots, telegramSessions, users } from "@/lib/db/schema";
import { telegramCipher } from "@/lib/crypto/telegram-cipher";
import { createLogger } from "@/lib/logger";
import { createTelegramClient } from "@/lib/telegram/client";
import { emitNotification } from "@/lib/notifications/emit";

const log = createLogger({ module: "slo-alerts" });

// Rolling window over which we evaluate "sustained" breach. A single red hour
// inside 48 good hours rolls up above target and will not fire — that is the
// point. The alert intent is "SLO has been missing target for a meaningful
// window", not "momentary dip".
export const SUSTAINED_WINDOW_HOURS = 48;

// Below this sample count we treat the window as no-signal rather than
// extrapolating from a handful of events. Prevents 3 SMS from triggering a
// page during a quiet weekend.
export const ALERT_MIN_SAMPLES = 20;

// Denominator kinds for parse_success — mirrors slos.ts but inlined to avoid
// re-exporting a coupling surface just for the alert path.
const PARSE_DENOMINATOR_KINDS = [
  "parse_outcome_success",
  "parse_needs_review",
  "ai_fallback_success",
  "ai_fallback_low_confidence",
  "ai_fallback_error",
] as const;

export type SloAlertKey = "parse_success";

export type SloAlertConfig = {
  key: SloAlertKey;
  label: string;
  target: number;
  compute: (now: Date, database?: DB) => Promise<{ rate: number | null; samples: number }>;
};

export async function computeParseSuccessOverWindow(
  now: Date,
  database: DB = db,
): Promise<{ rate: number | null; samples: number }> {
  const start = new Date(now.getTime() - SUSTAINED_WINDOW_HOURS * 60 * 60 * 1000);
  const [row] = await database
    .select({
      success: sql<number>`count(*) FILTER (WHERE ${parserEvents.eventKind} IN ('parse_outcome_success', 'ai_fallback_success'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(parserEvents)
    .where(
      and(
        gte(parserEvents.createdAt, start),
        eq(parserEvents.source, "sms"),
        inArray(parserEvents.eventKind, [...PARSE_DENOMINATOR_KINDS]),
      ),
    );
  const samples = row?.total ?? 0;
  const rate = samples === 0 ? null : (row.success ?? 0) / samples;
  return { rate, samples };
}

export const SLO_ALERTS: SloAlertConfig[] = [
  {
    key: "parse_success",
    label: "SMS parse success",
    target: 0.95,
    compute: (now, database) => computeParseSuccessOverWindow(now, database),
  },
];

export type SloDecision =
  | { action: "fire"; sloKey: SloAlertKey; rate: number; samples: number; target: number }
  | { action: "resolve"; sloKey: SloAlertKey; alertId: number }
  | { action: "noop"; sloKey: SloAlertKey; reason: string };

// Pure decision function — same contract as decideCanaryAction. Testable
// without a DB. `latestUnresolved` is null when no alert is open for this SLO.
export function decideSloAction(
  cfg: SloAlertConfig,
  computed: { rate: number | null; samples: number },
  latestUnresolved: { id: number } | null,
  minSamples = ALERT_MIN_SAMPLES,
): SloDecision {
  if (computed.rate === null || computed.samples < minSamples) {
    return { action: "noop", sloKey: cfg.key, reason: "insufficient_samples" };
  }
  if (computed.rate >= cfg.target) {
    if (latestUnresolved)
      return { action: "resolve", sloKey: cfg.key, alertId: latestUnresolved.id };
    return { action: "noop", sloKey: cfg.key, reason: "healthy" };
  }
  if (latestUnresolved) return { action: "noop", sloKey: cfg.key, reason: "already_alerted" };
  return {
    action: "fire",
    sloKey: cfg.key,
    rate: computed.rate,
    samples: computed.samples,
    target: cfg.target,
  };
}

// Orchestrator — runs every configured SLO through the decision flow and
// persists state + dispatches Telegram on fire. Returns all decisions for the
// cron route to echo back (useful for debugging: curl the endpoint and see
// what each SLO did this tick).
export async function checkAndAlertSlos(database: DB = db): Promise<SloDecision[]> {
  const now = new Date();
  const decisions: SloDecision[] = [];

  // Look up the admin once per invocation — reused by both Telegram dispatch
  // and the emitNotification call so we avoid a redundant query per SLO.
  const [admin] = await database
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true)))
    .limit(1);

  for (const cfg of SLO_ALERTS) {
    const computed = await cfg.compute(now, database);

    const [latestUnresolved] = await database
      .select({ id: sloAlerts.id })
      .from(sloAlerts)
      .where(and(eq(sloAlerts.sloKey, cfg.key), isNull(sloAlerts.resolvedAt)))
      .orderBy(desc(sloAlerts.firedAt))
      .limit(1);

    const decision = decideSloAction(cfg, computed, latestUnresolved ?? null);

    if (decision.action === "fire") {
      const status = await dispatchTelegramAlert(database, cfg, {
        rate: decision.rate,
        samples: decision.samples,
      }).catch((err) => {
        log.error({ err, event: "slo_telegram_dispatch_failed" }, "telegram dispatch failed");
        return "telegram_error";
      });
      const [alertRow] = await database
        .insert(sloAlerts)
        .values({
          sloKey: cfg.key,
          rate: decision.rate.toFixed(4),
          target: cfg.target.toFixed(4),
          samples: decision.samples,
          notificationStatus: status,
        })
        .returning({ id: sloAlerts.id });

      if (admin && alertRow) {
        const targetPct = (decision.target * 100).toFixed(0);
        await emitNotification(admin.id, {
          type: "slo_alert_fired",
          entityId: String(alertRow.id),
          audience: "admin",
          title: `SLO en alerta: ${cfg.label}`,
          body: `Burn rate ${(decision.rate * 100).toFixed(1)}% bajo el target ${targetPct}%.`,
          actionUrl: "/admin/slo",
          priority: "high",
          metadata: { alertId: alertRow.id, sloName: cfg.label, burnRate: decision.rate },
        }).catch((emitErr: unknown) => {
          log.error(
            {
              err: emitErr,
              adminId: admin.id,
              alertId: alertRow.id,
              event: "emit_slo_alert_fired_failed",
            },
            "failed to emit slo_alert_fired notification",
          );
        });
      }
    } else if (decision.action === "resolve") {
      await database
        .update(sloAlerts)
        .set({ resolvedAt: now })
        .where(eq(sloAlerts.id, decision.alertId));
    }

    decisions.push(decision);
  }

  return decisions;
}

async function dispatchTelegramAlert(
  database: DB,
  cfg: SloAlertConfig,
  computed: { rate: number; samples: number },
): Promise<string> {
  const [admin] = await database
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true)))
    .limit(1);
  if (!admin) return "no_admin";

  const [bot] = await database
    .select()
    .from(telegramBots)
    .where(eq(telegramBots.userId, admin.id))
    .limit(1);
  if (!bot) return "no_bot";

  const [session] = await database
    .select({ chatId: telegramSessions.chatId })
    .from(telegramSessions)
    .where(eq(telegramSessions.userId, admin.id))
    .orderBy(desc(telegramSessions.updatedAt))
    .limit(1);
  if (!session) return "no_session";

  let token: string;
  try {
    token = telegramCipher.decrypt(bot.tokenEncrypted);
  } catch {
    return "token_decrypt_failed";
  }

  const client = createTelegramClient({ token });
  const ratePct = (computed.rate * 100).toFixed(1);
  const targetPct = (cfg.target * 100).toFixed(0);
  const text = [
    `🚨 SLO alert — ${cfg.label}`,
    ``,
    `Rate (${SUSTAINED_WINDOW_HOURS}h): ${ratePct}% (target ≥ ${targetPct}%)`,
    `Samples: ${computed.samples}`,
    ``,
    `Deep link: /admin/slos?focus=${cfg.key}`,
  ].join("\n");

  await client.sendMessage({ chat_id: Number(session.chatId), text });
  return "telegram_sent";
}
