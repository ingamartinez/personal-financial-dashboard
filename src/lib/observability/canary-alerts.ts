import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import {
  canaryAlerts,
  parserCanaryEvents,
  telegramBots,
  telegramSessions,
  users,
} from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto/symmetric";
import { createTelegramClient } from "@/lib/telegram/client";
import type { TrendPoint } from "@/lib/telemetry/slos";

export const CANARY_AGREEMENT_THRESHOLD = 0.97;
export const CANARY_MIN_SAMPLES = 5;

export type AgreementStats = {
  rate: number | null;
  total: number;
  disagrees: number;
};

export async function computeAgreementRate24h(database: DB = db): Promise<AgreementStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await database
    .select({
      total: sql<number>`count(*)::int`,
      disagrees: sql<number>`count(*) filter (where ${parserCanaryEvents.agreement} = false)::int`,
    })
    .from(parserCanaryEvents)
    .where(gte(parserCanaryEvents.createdAt, since));
  const total = row?.total ?? 0;
  const disagrees = row?.disagrees ?? 0;
  const rate = total === 0 ? null : (total - disagrees) / total;
  return { rate, total, disagrees };
}

export async function computeAgreementTrend30d(database: DB = db): Promise<TrendPoint[]> {
  const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs);
  const rows = await database
    .select({
      day: sql<string>`to_char(date_trunc('day', ${parserCanaryEvents.createdAt}), 'YYYY-MM-DD')`,
      total: sql<number>`count(*)::int`,
      agrees: sql<number>`count(*) filter (where ${parserCanaryEvents.agreement} = true)::int`,
    })
    .from(parserCanaryEvents)
    .where(gte(parserCanaryEvents.createdAt, since))
    .groupBy(sql`date_trunc('day', ${parserCanaryEvents.createdAt})`);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: TrendPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(sinceMs + (29 - i) * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key);
    out.push({ date: key, value: r && r.total > 0 ? r.agrees / r.total : null });
  }
  return out;
}

export async function fetchTopDivergences(
  database: DB = db,
  limit = 3,
): Promise<Array<{ id: number; divergenceFields: string[]; smsBodyHash: string }>> {
  const rows = await database
    .select({
      id: parserCanaryEvents.id,
      divergenceFields: parserCanaryEvents.divergenceFields,
      smsBodyHash: parserCanaryEvents.smsBodyHash,
    })
    .from(parserCanaryEvents)
    .where(eq(parserCanaryEvents.agreement, false))
    .orderBy(desc(parserCanaryEvents.createdAt))
    .limit(limit);
  return rows;
}

export type CheckDecision =
  | { action: "fire"; stats: AgreementStats }
  | { action: "resolve"; stats: AgreementStats; alertId: number }
  | { action: "noop"; stats: AgreementStats; reason: string };

// Pure decision function — testable without hitting the DB transport.
// `latestUnresolved` is null when there's no open alert.
export function decideCanaryAction(
  stats: AgreementStats,
  latestUnresolved: { id: number } | null,
  thresholds = {
    agreementThreshold: CANARY_AGREEMENT_THRESHOLD,
    minSamples: CANARY_MIN_SAMPLES,
  },
): CheckDecision {
  if (stats.rate === null || stats.total < thresholds.minSamples) {
    return { action: "noop", stats, reason: "insufficient_samples" };
  }
  if (stats.rate >= thresholds.agreementThreshold) {
    if (latestUnresolved) return { action: "resolve", stats, alertId: latestUnresolved.id };
    return { action: "noop", stats, reason: "healthy" };
  }
  // rate < threshold
  if (latestUnresolved) return { action: "noop", stats, reason: "already_alerted" };
  return { action: "fire", stats };
}

export async function checkAndAlertCanary(database: DB = db): Promise<CheckDecision> {
  const stats = await computeAgreementRate24h(database);
  const [latestUnresolved] = await database
    .select({ id: canaryAlerts.id })
    .from(canaryAlerts)
    .where(isNull(canaryAlerts.resolvedAt))
    .orderBy(desc(canaryAlerts.firedAt))
    .limit(1);
  const decision = decideCanaryAction(stats, latestUnresolved ?? null);

  if (decision.action === "fire") {
    const topDivergences = await fetchTopDivergences(database, 3);
    const telegramStatus = await dispatchTelegramAlert(database, stats, topDivergences).catch(
      (err) => {
        console.error("[canary] telegram dispatch failed", err);
        return "telegram_error";
      },
    );
    await database.insert(canaryAlerts).values({
      rate: stats.rate!.toFixed(4),
      samples: stats.total,
      topDivergences,
      notificationStatus: telegramStatus,
    });
  } else if (decision.action === "resolve") {
    await database
      .update(canaryAlerts)
      .set({ resolvedAt: new Date() })
      .where(eq(canaryAlerts.id, decision.alertId));
  }

  return decision;
}

async function dispatchTelegramAlert(
  database: DB,
  stats: AgreementStats,
  topDivergences: Array<{ id: number; divergenceFields: string[]; smsBodyHash: string }>,
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
    token = decrypt(bot.tokenEncrypted);
  } catch {
    return "token_decrypt_failed";
  }

  const client = createTelegramClient({ token });
  const ratePct = (stats.rate! * 100).toFixed(1);
  const divergenceSummary = topDivergences.length
    ? topDivergences.map((d) => `• ${d.divergenceFields.join(", ")}`).join("\n")
    : "—";
  const text = [
    `🐤 Canary alert — parser drift detected`,
    ``,
    `Agreement rate (24h): ${ratePct}% (${stats.total - stats.disagrees}/${stats.total})`,
    `Disagrees: ${stats.disagrees}`,
    ``,
    `Top divergence fields:`,
    divergenceSummary,
    ``,
    `Details: /admin/slos/canary`,
  ].join("\n");

  await client.sendMessage({ chat_id: Number(session.chatId), text });
  return "telegram_sent";
}
