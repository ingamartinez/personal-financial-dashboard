/**
 * Widget handler: `mes-actual` — month-to-date spend with last-month comparison
 * and an end-of-month projection (#388).
 *
 * Medium tile. Three numbers travel together:
 *   - `spent_cop`                 — outflows from day 1 of this month through
 *                                   end of today, in Bogota TZ, absolute COP.
 *   - `last_month_same_day_cop`   — outflows from day 1 of last month through
 *                                   min(today's day, last month's last day).
 *                                   Caps at last month's last day so Feb (28)
 *                                   after Mar 31 still produces a sane compare.
 *   - `projection_month_end_cop`  — linear extrapolation of spend through
 *                                   month end: `round(spent/day * dim)`.
 *
 * Exclusions match #387 (`hoy`): soft-deleted, balance adjustments,
 * transfers, and positive amounts (credits / refunds) all drop out. See
 * `hoy.ts` for the rationale — this handler is the month-scoped sibling.
 *
 * Size: tile-only for `M`. `S` and `L` → 422 invalid_params.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted, notTransfer } from "@/lib/db/helpers";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { toCop } from "@/lib/money";
import type { Currency } from "@/lib/types";
import type { WidgetHandler, WidgetHandlerResult } from "@/app/api/widget/v1/[id]/registry";
import { bogotaIsoNow, centsToCop } from "./_shared";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type MesActualData = {
  /** Spanish-locale human label, e.g. "Abril 2026" (capitalized month + year). */
  month_label: string;
  spent_cop: number;
  day_of_month: number;
  last_month_same_day_cop: number;
  /** null when there was no spend in the comparable window last month. */
  delta_pct: number | null;
  delta_direction: "up" | "down" | "flat" | null;
  projection_month_end_cop: number;
};

type MesActualResponse = {
  widget_id: "mes-actual";
  size: "M";
  data: MesActualData;
  generated_at: string;
};

type MesActualErrorCode = "invalid_params";

type MesActualErrorBody = { error: { code: MesActualErrorCode; message: string } };

const STATUS_BY_CODE: Record<MesActualErrorCode, number> = {
  invalid_params: 422,
};

function errorResult(code: MesActualErrorCode, message: string): WidgetHandlerResult {
  const body: MesActualErrorBody = { error: { code, message } };
  return { body, status: STATUS_BY_CODE[code] };
}

// ---------------------------------------------------------------------------
// Bogota-aware date helpers. Mirror `hoy.ts` — Colombia has no DST so UTC-5
// is exact year-round, which keeps the SQL side deterministic.
// ---------------------------------------------------------------------------

const BOGOTA_TZ = "America/Bogota";
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

type BogotaYmd = { year: number; month: number; day: number };

function nowInBogota(now: Date): BogotaYmd {
  const shifted = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1, // 1..12
    day: shifted.getUTCDate(),
  };
}

/**
 * Number of days in `(year, month)` — `month` is 1-indexed. Uses the JS
 * "zero day of next month" trick, which is exact for all real calendar
 * months (including Feb leap years) because `Date` normalizes.
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Returns the (year, month) pair representing the calendar month BEFORE
 * `(year, month)`. Handles January → December of the previous year.
 */
function previousMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Returns "Abril 2026" style label for `now` in Bogota. Built with
 * `Intl.DateTimeFormat` part-by-part so we can capitalize the month and
 * strip any trailing ICU "." on short forms — but here we ask for `long`
 * month, so the only cleanup needed is capitalization.
 */
export function formatMonthLabel(now: Date): string {
  const fmt = new Intl.DateTimeFormat("es-CO", {
    month: "long",
    year: "numeric",
    timeZone: BOGOTA_TZ,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const month = capitalize(get("month"));
  const year = get("year");
  return `${month} ${year}`;
}

// ---------------------------------------------------------------------------
// Shared SQL helper: transaction's Bogota-local calendar date. Applied at the
// database so a tx at 23:30 Bogota (04:30 UTC next day) still lands on the
// Bogota day the user expects.
// ---------------------------------------------------------------------------

const txBogotaDateSql = sql`((${transactions.occurredAt}) AT TIME ZONE ${sql.raw(
  `'${BOGOTA_TZ}'`,
)})::date`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const mesActualHandler: WidgetHandler = async (ctx) => {
  if (ctx.size !== "M") {
    return errorResult("invalid_params", "mes-actual only supports size M");
  }

  const now = new Date();
  const today = nowInBogota(now);
  const dayOfMonth = today.day;
  const dim = daysInMonth(today.year, today.month);

  // "Current month" window: day 1 through end of today (inclusive). The SQL
  // uses `>= firstOfMonth AND <= today` on the Bogota date.
  const firstOfMonthStr = `${today.year}-${String(today.month).padStart(2, "0")}-01`;
  const todayStr = `${today.year}-${String(today.month).padStart(2, "0")}-${String(
    today.day,
  ).padStart(2, "0")}`;

  // "Last month" window: day 1 through min(today's day, last month's last day).
  // Example edge: today = Mar 31 → last month = Feb with 28 days → compare
  // through Feb 28 only. Today = Apr 30 → last month = Mar with 31 days →
  // compare through Mar 30 (cap stays at today's day).
  const prev = previousMonth(today.year, today.month);
  const prevDim = daysInMonth(prev.year, prev.month);
  const prevCapDay = Math.min(dayOfMonth, prevDim);
  const prevFirstStr = `${prev.year}-${String(prev.month).padStart(2, "0")}-01`;
  const prevLastStr = `${prev.year}-${String(prev.month).padStart(2, "0")}-${String(
    prevCapDay,
  ).padStart(2, "0")}`;

  // Prefilter on `occurred_at` uses the cartesian hull of both windows so
  // Postgres can still use the `(user_id, occurred_at)` index. The bounds
  // are generous by one TZ offset at each edge so a 23:59 Bogota tx on the
  // last day (04:59 UTC next day) isn't missed.
  const prefilterStart = new Date(Date.UTC(prev.year, prev.month - 1, 1) - BOGOTA_OFFSET_MS);
  const prefilterEnd = new Date(
    Date.UTC(today.year, today.month - 1, today.day) + 2 * 24 * 60 * 60 * 1000,
  );

  // One round-trip per currency: split into "current MTD" vs "last-month
  // comparable window". Sums are pre-negated so callers just add them up.
  const rows = await db
    .select({
      currency: transactions.currency,
      spentCurrentCents: sql<string>`
        COALESCE(
          SUM(
            CASE
              WHEN ${txBogotaDateSql} >= ${firstOfMonthStr}::date
                AND ${txBogotaDateSql} <= ${todayStr}::date
                AND ${transactions.amountCents} < 0
              THEN -${transactions.amountCents}
              ELSE 0
            END
          ),
          0
        )
      `,
      spentLastMonthCents: sql<string>`
        COALESCE(
          SUM(
            CASE
              WHEN ${txBogotaDateSql} >= ${prevFirstStr}::date
                AND ${txBogotaDateSql} <= ${prevLastStr}::date
                AND ${transactions.amountCents} < 0
              THEN -${transactions.amountCents}
              ELSE 0
            END
          ),
          0
        )
      `,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, ctx.userId),
        gte(transactions.occurredAt, prefilterStart),
        lt(transactions.occurredAt, prefilterEnd),
        // Exclusions — see file header. Same set as `hoy`.
        notDeleted(transactions.deletedAt),
        notAdjustment(transactions.isAdjustment),
        sql`${transactions.source} <> 'balance_adjustment'`,
        notTransfer(transactions.channel),
      ),
    )
    .groupBy(transactions.currency);

  // Same optimization as `hoy` / `mis-tcs`: only fetch FX when a USD row
  // survived the filters with a non-zero sum. COP-only users pay nothing.
  const needsFx = rows.some(
    (r) =>
      r.currency === "USD" &&
      (BigInt(r.spentCurrentCents) !== BigInt(0) || BigInt(r.spentLastMonthCents) !== BigInt(0)),
  );
  const fxRate = needsFx ? (await getCurrentFxRate()).rate : 0;

  let spentCurrentCopCents = BigInt(0);
  let spentLastMonthCopCents = BigInt(0);
  for (const r of rows) {
    const currency = r.currency as Currency;
    spentCurrentCopCents += toCop(BigInt(r.spentCurrentCents), currency, fxRate);
    spentLastMonthCopCents += toCop(BigInt(r.spentLastMonthCents), currency, fxRate);
  }

  const spentCop = centsToCop(spentCurrentCopCents);
  const lastMonthSameDayCop = centsToCop(spentLastMonthCopCents);

  // Delta and direction. When last-month spend is 0 we can't compute a
  // percentage, so both fields report null — better UX than "+∞%".
  let deltaPct: number | null;
  let deltaDirection: MesActualData["delta_direction"];
  if (lastMonthSameDayCop === 0) {
    deltaPct = null;
    deltaDirection = null;
  } else {
    deltaPct = Math.round((spentCop / lastMonthSameDayCop - 1) * 100);
    if (deltaPct > 0) deltaDirection = "up";
    else if (deltaPct < 0) deltaDirection = "down";
    else deltaDirection = "flat";
  }

  // Projection: linear extrapolation of daily burn rate out to month end.
  // Guards:
  //   - dayOfMonth 0 (shouldn't happen, defensive): return 0
  //   - dayOfMonth 1 + spentCop 0: return 0 (day hasn't really started)
  //   - otherwise: round(spent/day * daysInMonth)
  let projectionMonthEndCop: number;
  if (dayOfMonth === 0) {
    projectionMonthEndCop = 0;
  } else if (dayOfMonth === 1 && spentCop === 0) {
    projectionMonthEndCop = 0;
  } else {
    projectionMonthEndCop = Math.round((spentCop / dayOfMonth) * dim);
  }

  const body: MesActualResponse = {
    widget_id: "mes-actual",
    size: "M",
    data: {
      month_label: formatMonthLabel(now),
      spent_cop: spentCop,
      day_of_month: dayOfMonth,
      last_month_same_day_cop: lastMonthSameDayCop,
      delta_pct: deltaPct,
      delta_direction: deltaDirection,
      projection_month_end_cop: projectionMonthEndCop,
    },
    generated_at: bogotaIsoNow(now),
  };
  return { body };
};
