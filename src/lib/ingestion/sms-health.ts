import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ingestionLogs } from "@/lib/db/schema";

// Drift detection thresholds. Hardcoded for now; editable UI tracked in issue #165.
export const DRIFT_CONFIG = {
  /** Today's inserted count must be below avg * ratio to flag drift. */
  ratio: 0.5,
  /** Flag only fires once local COP time is at/after this hour. */
  eveningHourCop: 20,
  /** If avg is below this floor, skip the drift check (baseline too sparse to matter). */
  minBaseline: 2,
} as const;

// Colombia is UTC-5 year-round.
const COP_OFFSET_HOURS = -5;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function toCopClock(now: Date): Date {
  return new Date(now.getTime() + COP_OFFSET_HOURS * MS_PER_HOUR);
}

export function todayInCop(now: Date = new Date()): string {
  return toCopClock(now).toISOString().slice(0, 10);
}

export function hourInCop(now: Date = new Date()): number {
  return toCopClock(now).getUTCHours();
}

/** Compute the UTC Date corresponding to 00:00 COP on (today in COP - daysAgo). */
function startOfCopDayUtc(now: Date, daysAgo: number): Date {
  const cop = toCopClock(now);
  const startOfTodayUtcMs = Date.UTC(
    cop.getUTCFullYear(),
    cop.getUTCMonth(),
    cop.getUTCDate(),
    -COP_OFFSET_HOURS,
    0,
    0,
  );
  return new Date(startOfTodayUtcMs - daysAgo * MS_PER_DAY);
}

export type SmsHealthDay = {
  copDate: string;
  inserted: number;
  duplicated: number;
  skipped: number;
  error: number;
  lastSmsAt: Date | null;
};

export type SmsHealthSnapshot = {
  todayCopDate: string;
  nowCopHour: number;
  todayInserted: number;
  todaySkipped: number;
  todayDuplicated: number;
  todayError: number;
  lastSmsAt: Date | null;
  sevenDayAvgInserted: number;
  isDrift: boolean;
};

export function computeIsDrift(input: {
  todayInserted: number;
  sevenDayAvgInserted: number;
  nowCopHour: number;
}): boolean {
  if (input.sevenDayAvgInserted < DRIFT_CONFIG.minBaseline) return false;
  if (input.nowCopHour < DRIFT_CONFIG.eveningHourCop) return false;
  return input.todayInserted < input.sevenDayAvgInserted * DRIFT_CONFIG.ratio;
}

export async function getSmsHealthHistory(
  userId: number,
  days = 30,
  now: Date = new Date(),
): Promise<SmsHealthDay[]> {
  const cutoff = startOfCopDayUtc(now, days - 1);
  const rows = await db
    .select({
      copDate: sql<string>`to_char(((${ingestionLogs.startedAt}) AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD')`,
      inserted: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} = 'inserted')::int`,
      duplicated: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} = 'duplicated')::int`,
      skipped: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} = 'skipped')::int`,
      error: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} = 'error')::int`,
      lastSmsAt: sql<string | null>`max(${ingestionLogs.startedAt})`,
    })
    .from(ingestionLogs)
    .where(
      and(
        eq(ingestionLogs.userId, userId),
        eq(ingestionLogs.source, "sms"),
        gte(ingestionLogs.startedAt, cutoff),
      ),
    )
    .groupBy(sql`((${ingestionLogs.startedAt}) AT TIME ZONE 'America/Bogota')::date`)
    .orderBy(sql`((${ingestionLogs.startedAt}) AT TIME ZONE 'America/Bogota')::date DESC`);

  return rows.map((r) => ({
    copDate: r.copDate,
    inserted: r.inserted,
    duplicated: r.duplicated,
    skipped: r.skipped,
    error: r.error,
    lastSmsAt: r.lastSmsAt ? new Date(r.lastSmsAt) : null,
  }));
}

export async function getSmsHealthSnapshot(
  userId: number,
  now: Date = new Date(),
): Promise<SmsHealthSnapshot> {
  const history = await getSmsHealthHistory(userId, 8, now);
  const todayCopDate = todayInCop(now);
  const nowCopHour = hourInCop(now);

  const today = history.find((h) => h.copDate === todayCopDate);
  const previousDays = history.filter((h) => h.copDate !== todayCopDate).slice(0, 7);

  const todayInserted = today?.inserted ?? 0;
  // Average across 7 calendar days (missing days count as 0, so we divide by 7 regardless).
  const totalPrevInserted = previousDays.reduce((sum, d) => sum + d.inserted, 0);
  const sevenDayAvgInserted = totalPrevInserted / 7;

  return {
    todayCopDate,
    nowCopHour,
    todayInserted,
    todaySkipped: today?.skipped ?? 0,
    todayDuplicated: today?.duplicated ?? 0,
    todayError: today?.error ?? 0,
    lastSmsAt: today?.lastSmsAt ?? null,
    sevenDayAvgInserted,
    isDrift: computeIsDrift({ todayInserted, sevenDayAvgInserted, nowCopHour }),
  };
}
