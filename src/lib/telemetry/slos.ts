import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ingestionLogs, transactions } from "@/lib/db/schema";

// Bancolombia Parser SLOs (PLAN.md §"Bancolombia Parser SLOs"). System-wide
// aggregates across all users — NOT per-user (that is /admin/health).
//
// These gate Phase 8 (second bank). "Bancolombia works well" must be
// measurable, not aspirational.

export type SloWindow = 7 | 30 | 90;

export type SloKey =
  | "parse_success"
  | "classification_rate"
  | "dedup_success"
  | "onboarding_time"
  | "data_loss"
  | "detection_lag";

export type SloStatus = "green" | "yellow" | "red" | "no-signal";

export type SloResult = {
  key: SloKey;
  label: string;
  description: string;
  target: string;
  /** Display-ready value, e.g. "97.3%" or "4m 12s" or "0". */
  display: string;
  /** Raw value; null = "no signal" (no data in window). */
  raw: number | null;
  status: SloStatus;
  /** Optional link to drill into the failing events. */
  drilldown?: string;
  /** Daily trend points over the window; value=null when the day had no signal. */
  trend: TrendPoint[];
};

export type TrendPoint = { date: string; value: number | null };

const MS_PER_DAY = 86_400_000;

function windowStart(windowDays: SloWindow, now: Date): Date {
  return new Date(now.getTime() - windowDays * MS_PER_DAY);
}

function percent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function statusFor(raw: number | null, target: number, higherIsBetter: boolean): SloStatus {
  if (raw === null) return "no-signal";
  if (higherIsBetter) {
    if (raw >= target) return "green";
    if (raw >= target * 0.95) return "yellow";
    return "red";
  }
  if (raw <= target) return "green";
  if (raw <= target * 1.2) return "yellow";
  return "red";
}

// ---------------------------------------------------------------------------
// SLO #1 — SMS parse success rate (target ≥ 95%)
// ---------------------------------------------------------------------------

/**
 * Aggregates across ALL users, filters out ai-classify + debug-capture rows
 * (same semantics as `computeUserHealthSnapshot`). success = inserted|duplicated.
 */
export async function sloParseSuccess(
  windowDays: SloWindow,
  now: Date = new Date(),
): Promise<SloResult> {
  const start = windowStart(windowDays, now);

  const [row] = await db
    .select({
      success: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} IN ('inserted', 'duplicated'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(ingestionLogs)
    .where(
      and(
        gte(ingestionLogs.startedAt, start),
        sql`(${ingestionLogs.payload} ->> 'kind') NOT IN ('ai-classify', 'debug-capture') OR (${ingestionLogs.payload} ->> 'kind') IS NULL`,
      ),
    );

  const raw = row.total === 0 ? null : row.success / row.total;
  const trend = await dailyParseSuccessTrend(windowDays, now);

  return {
    key: "parse_success",
    label: "SMS parse success",
    description:
      "Ingests terminados sin error (inserted o duplicated) / total. Excluye ai-classify y debug.",
    target: "≥ 95%",
    display: raw === null ? "—" : percent(raw),
    raw,
    status: statusFor(raw, 0.95, true),
    drilldown: "/settings/inbox",
    trend,
  };
}

async function dailyParseSuccessTrend(windowDays: SloWindow, now: Date): Promise<TrendPoint[]> {
  const start = windowStart(windowDays, now);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${ingestionLogs.startedAt} AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD')`,
      success: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} IN ('inserted', 'duplicated'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(ingestionLogs)
    .where(
      and(
        gte(ingestionLogs.startedAt, start),
        sql`(${ingestionLogs.payload} ->> 'kind') NOT IN ('ai-classify', 'debug-capture') OR (${ingestionLogs.payload} ->> 'kind') IS NULL`,
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return fillDailyTrend(
    rows.map((r) => ({ date: r.day, value: r.total === 0 ? null : r.success / r.total })),
    windowDays,
    now,
  );
}

// ---------------------------------------------------------------------------
// SLO #2 — Classification rate (rule + ai) / total (target ≥ 90%)
// ---------------------------------------------------------------------------

export async function sloClassificationRate(
  windowDays: SloWindow,
  now: Date = new Date(),
): Promise<SloResult> {
  const start = windowStart(windowDays, now);

  const [row] = await db
    .select({
      auto: sql<number>`count(*) FILTER (WHERE ${transactions.classificationMethod} IN ('rule', 'ai'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(gte(transactions.createdAt, start));

  const raw = row.total === 0 ? null : row.auto / row.total;

  const trendRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${transactions.createdAt} AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD')`,
      auto: sql<number>`count(*) FILTER (WHERE ${transactions.classificationMethod} IN ('rule', 'ai'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(gte(transactions.createdAt, start))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const trend = fillDailyTrend(
    trendRows.map((r) => ({ date: r.day, value: r.total === 0 ? null : r.auto / r.total })),
    windowDays,
    now,
  );

  return {
    key: "classification_rate",
    label: "Clasificación automática",
    description:
      "Transacciones categorizadas por regla o AI / total. Excluye manual y unclassified.",
    target: "≥ 90%",
    display: raw === null ? "—" : percent(raw),
    raw,
    status: statusFor(raw, 0.9, true),
    trend,
  };
}

// ---------------------------------------------------------------------------
// SLO #3 — Dedup success (target ≥ 98%)
//
// MVP: we have no ground truth for "silent wrong dedup" until Epic R ships
// bank-statement reconciliation. Report duplicate-rejection count as a leading
// indicator with status='no-signal' so the dashboard shows "not yet measurable"
// instead of faking a number.
// ---------------------------------------------------------------------------

export async function sloDedupSuccess(
  windowDays: SloWindow,
  now: Date = new Date(),
): Promise<SloResult> {
  const start = windowStart(windowDays, now);

  const [row] = await db
    .select({
      duplicated: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} = 'duplicated')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(ingestionLogs)
    .where(
      and(
        gte(ingestionLogs.startedAt, start),
        sql`(${ingestionLogs.payload} ->> 'kind') NOT IN ('ai-classify', 'debug-capture') OR (${ingestionLogs.payload} ->> 'kind') IS NULL`,
      ),
    );

  return {
    key: "dedup_success",
    label: "Dedup correctness",
    description:
      "Requiere ground truth de extractos bancarios (Epic R) para medir correctness real. Por ahora: duplicate-rejection count como leading indicator.",
    target: "≥ 98%",
    display: `${row.duplicated} rejected / ${row.total}`,
    raw: null,
    status: "no-signal",
    trend: [],
  };
}

// ---------------------------------------------------------------------------
// SLO #4 — Onboarding completion time (signup → first txn, target ≤ 5 min)
// ---------------------------------------------------------------------------

export async function sloOnboardingTime(
  windowDays: SloWindow,
  now: Date = new Date(),
): Promise<SloResult> {
  const start = windowStart(windowDays, now);

  const rows = await db.execute<{ seconds: string | null }>(sql`
    SELECT EXTRACT(EPOCH FROM (first_tx.first_at - u.created_at))::text AS seconds
    FROM users u
    JOIN LATERAL (
      SELECT min(t.created_at) AS first_at
      FROM transactions t
      WHERE t.user_id = u.id
    ) first_tx ON TRUE
    WHERE u.created_at >= ${start.toISOString()}::timestamptz
      AND first_tx.first_at IS NOT NULL
      AND first_tx.first_at >= u.created_at
  `);

  const seconds = rows
    .map((r) => (r.seconds === null ? null : Number(r.seconds)))
    .filter((s): s is number => s !== null && Number.isFinite(s));

  if (seconds.length === 0) {
    return {
      key: "onboarding_time",
      label: "Tiempo de onboarding",
      description:
        "Mediana signup → primer transaction creada. Ventana: users creados en el rango.",
      target: "≤ 5 min",
      display: "—",
      raw: null,
      status: "no-signal",
      trend: [],
    };
  }

  seconds.sort((a, b) => a - b);
  const median = seconds[Math.floor(seconds.length / 2)];

  return {
    key: "onboarding_time",
    label: "Tiempo de onboarding (p50)",
    description: `Mediana signup → primer transaction creada. N=${seconds.length} users en la ventana.`,
    target: "≤ 5 min",
    display: formatSeconds(median),
    raw: median,
    status: statusFor(median, 300, false),
    trend: [],
  };
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ---------------------------------------------------------------------------
// SLO #5 — Data loss incidents per user/month (target = 0)
//
// Measured as: unresolved error logs. After #261 (Ingestion Inbox) landed,
// any errored ingest has a resolve/dismiss path. An unresolved error is a
// data-loss incident until the user acts.
// ---------------------------------------------------------------------------

export async function sloDataLoss(): Promise<SloResult> {
  const [row] = await db
    .select({
      unresolved: sql<number>`count(*)::int`,
      affectedUsers: sql<number>`count(DISTINCT ${ingestionLogs.userId})::int`,
    })
    .from(ingestionLogs)
    .where(and(eq(ingestionLogs.status, "error"), isNull(ingestionLogs.resolvedAt)));

  return {
    key: "data_loss",
    label: "Data loss pendiente",
    description:
      "Logs de ingesta en error sin resolver (retry/dismiss). Cada uno es un ingest que no creó tx.",
    target: "= 0",
    display: `${row.unresolved} en ${row.affectedUsers} user${row.affectedUsers === 1 ? "" : "s"}`,
    raw: row.unresolved,
    status: row.unresolved === 0 ? "green" : row.unresolved < 5 ? "yellow" : "red",
    drilldown: "/settings/inbox",
    trend: [],
  };
}

// ---------------------------------------------------------------------------
// SLO #6 — Time-to-detect parser break (target ≤ 24h)
//
// MVP: age of the oldest unresolved error log. If any error has been unresolved
// for >24h, we've failed to detect. When alerting lands, this becomes lag from
// drop to operator ack.
// ---------------------------------------------------------------------------

export async function sloDetectionLag(
  _windowDays: SloWindow,
  now: Date = new Date(),
): Promise<SloResult> {
  const [row] = await db
    .select({
      oldest: sql<string | null>`min(${ingestionLogs.startedAt})`,
    })
    .from(ingestionLogs)
    .where(and(eq(ingestionLogs.status, "error"), isNull(ingestionLogs.resolvedAt)));

  if (!row.oldest) {
    return {
      key: "detection_lag",
      label: "Detection lag",
      description: "Edad del error más viejo sin resolver. Si supera 24h, no detectamos a tiempo.",
      target: "≤ 24h",
      display: "0 (sin errores pendientes)",
      raw: 0,
      status: "green",
      trend: [],
    };
  }

  const oldestDate = new Date(row.oldest);
  const ageSeconds = (now.getTime() - oldestDate.getTime()) / 1000;

  return {
    key: "detection_lag",
    label: "Detection lag",
    description: "Edad del error más viejo sin resolver. Si supera 24h, no detectamos a tiempo.",
    target: "≤ 24h",
    display: formatSeconds(ageSeconds),
    raw: ageSeconds,
    status: statusFor(ageSeconds, 24 * 3600, false),
    drilldown: "/settings/inbox",
    trend: [],
  };
}

// ---------------------------------------------------------------------------
// Orchestration — fetch all 6 in parallel
// ---------------------------------------------------------------------------

export async function computeAllSlos(
  windowDays: SloWindow,
  now: Date = new Date(),
): Promise<SloResult[]> {
  return Promise.all([
    sloParseSuccess(windowDays, now),
    sloClassificationRate(windowDays, now),
    sloDedupSuccess(windowDays, now),
    sloOnboardingTime(windowDays, now),
    sloDataLoss(),
    sloDetectionLag(windowDays, now),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pads a day-keyed trend series to include every day in the window, so the
 * sparkline has stable width regardless of data density.
 */
function fillDailyTrend(points: TrendPoint[], windowDays: SloWindow, now: Date): TrendPoint[] {
  const map = new Map(points.map((p) => [p.date, p.value]));
  const out: TrendPoint[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * MS_PER_DAY);
    // YYYY-MM-DD in the Bogota offset used by the SQL. For sparkline alignment
    // the exact TZ is low-stakes — what matters is density + order.
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: map.has(key) ? (map.get(key) ?? null) : null });
  }
  return out;
}
