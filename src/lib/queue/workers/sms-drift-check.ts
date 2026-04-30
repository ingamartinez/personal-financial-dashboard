import type { Job } from "bullmq";

import { db } from "@/lib/db";
import { ingestionLogs } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { emitNotification } from "@/lib/notifications/emit";
import { createWorker } from "@/lib/queue";
import { and, eq, gte, lt, sql } from "drizzle-orm";

const log = createLogger({ module: "worker/sms-drift-check" });

export type SmsDriftCheckJobData = Record<string, never>;

/**
 * Returns the start and end of "today" in America/Bogota as UTC timestamps.
 * The cron runs at 22:30 COT — well within the day — so "today" is reliable.
 */
function getBogotaDayBoundaries(): { todayStart: Date; todayEnd: Date; todayISODate: string } {
  const nowUtc = new Date();
  // Obtain YYYY-MM-DD in Bogota time
  const bogotaDateStr = nowUtc.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
  // todayISODate is the Bogota calendar date, e.g. "2026-04-30"
  const todayISODate = bogotaDateStr;

  // Reconstruct midnight COT boundaries in UTC.
  // COT = UTC-5. "2026-04-30T00:00:00-05:00" → add 5h to get UTC.
  const todayStart = new Date(`${todayISODate}T00:00:00-05:00`);
  const todayEnd = new Date(`${todayISODate}T23:59:59.999-05:00`);

  return { todayStart, todayEnd, todayISODate };
}

interface UserDriftRow {
  userId: number;
  countToday: number;
  sumLast7ExcludingToday: number;
}

/**
 * Queries ingestion_logs to find users where SMS activity shows a drift today.
 *
 * For each user who has had at least one SMS log in the last 7 days:
 *   - count_today = SUM(items_received) WHERE source='sms', startedAt in Bogota-today
 *   - avg_7d = SUM(items_received) for last 7 calendar days EXCLUDING today, divided by 7
 *   - emit if count_today === 0 AND avg_7d >= 5
 *
 * Uses AT TIME ZONE for correct Bogota day boundaries in Postgres.
 */
async function detectSmsDrift(): Promise<UserDriftRow[]> {
  const { todayStart, todayEnd, todayISODate } = getBogotaDayBoundaries();

  // 7-day window start = todayStart minus 7 days
  const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  // postgres.js requires ISO strings (not Date objects) when embedded in raw
  // sql`` template expressions. Column-operator helpers (gte/lt) handle Date
  // serialization internally, but values inside CASE WHEN must be explicit strings.
  const todayStartIso = todayStart.toISOString();
  const todayEndIso = todayEnd.toISOString();
  const sevenDaysAgoIso = sevenDaysAgo.toISOString();

  const rows = await db
    .select({
      userId: ingestionLogs.userId,
      countToday:
        sql<number>`COALESCE(SUM(CASE WHEN ${ingestionLogs.startedAt} >= ${todayStartIso}::timestamptz AND ${ingestionLogs.startedAt} < ${todayEndIso}::timestamptz THEN ${ingestionLogs.itemsReceived} ELSE 0 END), 0)`.as(
          "count_today",
        ),
      sumLast7ExcludingToday:
        sql<number>`COALESCE(SUM(CASE WHEN ${ingestionLogs.startedAt} >= ${sevenDaysAgoIso}::timestamptz AND ${ingestionLogs.startedAt} < ${todayStartIso}::timestamptz THEN ${ingestionLogs.itemsReceived} ELSE 0 END), 0)`.as(
          "sum_last7_excl_today",
        ),
    })
    .from(ingestionLogs)
    .where(
      and(
        eq(ingestionLogs.source, "sms"),
        gte(ingestionLogs.startedAt, sevenDaysAgo),
        lt(ingestionLogs.startedAt, todayEnd),
      ),
    )
    .groupBy(ingestionLogs.userId);

  log.debug(
    { todayISODate, rowCount: rows.length, event: "sms_drift_query_done" },
    "sms-drift query complete",
  );

  return rows.map((r) => ({
    userId: r.userId,
    countToday: Number(r.countToday),
    sumLast7ExcludingToday: Number(r.sumLast7ExcludingToday),
  }));
}

/**
 * Core processor: for each user who had SMS activity in the last 7 days but
 * sent 0 SMS today, emit an `sms_drift_detected` notification.
 *
 * Threshold: avg_7d >= 5 SMS/day (sum of last 7 excl. today ÷ 7).
 * This avoids false positives for occasional users.
 *
 * Dedup: entityId = "sms-drift-{userId}-{YYYY-MM-DD}" — at most one
 * unread notification per user per calendar day (Bogota).
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function smsDriftCheckProcessor(job: Job<SmsDriftCheckJobData>): Promise<void> {
  const { todayISODate } = getBogotaDayBoundaries();

  log.info(
    { event: "sms_drift_check_start", jobId: job.id, todayISODate },
    "sms-drift-check started",
  );

  await job.updateProgress({ phase: "querying" });
  await job.log(`start: checking sms drift for ${todayISODate}`);

  const rows = await detectSmsDrift();

  const THRESHOLD_AVG = 5;
  let emitted = 0;
  let skipped = 0;
  let deduped = 0;

  for (const row of rows) {
    const avg7d = row.sumLast7ExcludingToday / 7;

    if (row.countToday > 0) {
      log.debug(
        { userId: row.userId, countToday: row.countToday, event: "sms_drift_has_activity" },
        "user has sms today — skip",
      );
      skipped++;
      continue;
    }

    if (avg7d < THRESHOLD_AVG) {
      log.debug(
        { userId: row.userId, avg7d, threshold: THRESHOLD_AVG, event: "sms_drift_below_threshold" },
        "avg below threshold — skip",
      );
      skipped++;
      continue;
    }

    // count_today === 0 AND avg_7d >= 5 — emit
    const entityId = `sms-drift-${row.userId}-${todayISODate}`;

    const result = await emitNotification(row.userId, {
      type: "sms_drift_detected",
      entityId,
      priority: "medium",
      title: "No recibimos SMS hoy",
      body: `Tu promedio de los últimos 7 días era ${avg7d.toFixed(1)} SMS/día. Hoy llegaron 0. Revisá si el Shortcut sigue corriendo.`,
      actionUrl: "/settings/integrations",
      metadata: { avg7d, count_today: 0, todayISODate },
    });

    if (result === null) {
      log.debug(
        { userId: row.userId, entityId, event: "sms_drift_deduped" },
        "sms-drift notification deduped",
      );
      deduped++;
    } else {
      log.info(
        {
          userId: row.userId,
          notificationId: result.id,
          avg7d,
          entityId,
          event: "sms_drift_emitted",
        },
        "sms-drift notification emitted",
      );
      emitted++;
    }
  }

  await job.updateProgress({ done: true, emitted, skipped, deduped });
  await job.log(
    `done: users=${rows.length} emitted=${emitted} skipped=${skipped} deduped=${deduped}`,
  );

  log.info(
    {
      event: "sms_drift_check_done",
      todayISODate,
      total: rows.length,
      emitted,
      skipped,
      deduped,
      jobId: job.id,
    },
    "sms-drift-check complete",
  );
}

/**
 * Create and register the sms-drift-check BullMQ worker.
 *
 * Concurrency 1: the processor fans out over all users synchronously.
 * Running concurrent jobs would duplicate emits (dedup in Postgres handles
 * it, but unnecessary load).
 *
 * Cron: 22:30 America/Bogota — late enough that a day's SMS window is
 * effectively closed, early enough to alert before the user sleeps.
 */
export function createSmsDriftCheckWorker() {
  return createWorker<SmsDriftCheckJobData, void>(
    "sms-drift-check",
    async (job) => {
      try {
        await smsDriftCheckProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "sms_drift_check_failed", jobId: job.id },
          "sms-drift-check processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
