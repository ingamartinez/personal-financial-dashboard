/**
 * Widget handler: `hoy` — today's spending snapshot (#387).
 *
 * Single small tile: "how much did you spend TODAY, on how many transactions,
 * and how does that compare to your daily average so far this month". All
 * timestamps are anchored to America/Bogota — Colombia has no DST, so a
 * fixed UTC-5 offset is exact, which keeps the SQL simple and deterministic.
 *
 * NOTE: the timezone is hard-coded to America/Bogota for this first pass.
 * When user preferences (#TBD) land, this should read from
 * `users.timezone` (or equivalent) — see the `BOGOTA_TZ` constant below.
 *
 * Exclusions — what does NOT count as "gasto":
 *   - Soft-deleted transactions (`notDeleted`).
 *   - Balance adjustments (`source = 'balance_adjustment'` OR
 *     `is_adjustment = true`). These are reconciliation artifacts, not spend.
 *   - Transfers (`channel = 'transfer'`). Payments to a credit card and
 *     internal moves are excluded — see memory `pago-tc-modeled-as-expense`
 *     for why this is the right shape.
 *   - Credits / refunds (positive `amount_cents`). Only outflows count
 *     towards the "spent" figure.
 *
 * All surviving rows are currency-converted to COP at the current TRM, then
 * summed in bigint cents and narrowed to integer pesos for the response.
 *
 * `vs_daily_avg_pct` semantics:
 *   avg_daily_MTD = |sum(qualifying txs from day-1 through yesterday)|
 *                   / (today.day - 1)
 *   If today is day 1 → `null` (no prior days yet).
 *   Else             → round((spent_today / avg_daily_MTD - 1) * 100).
 *   Negative means you spent LESS than the MTD daily average.
 *
 * Size: tile-only. Any size other than `S` → 422 invalid_params.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { toCop } from "@/lib/money";
import type { Currency } from "@/lib/types";
import type { WidgetHandler, WidgetHandlerResult } from "@/app/api/widget/v1/[id]/registry";
import { bogotaIsoNow, centsToCop } from "./_shared";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type HoyData = {
  spent_cop: number;
  tx_count: number;
  /** null when today is day 1 of the month (no prior days to compare). */
  vs_daily_avg_pct: number | null;
  /** Spanish-locale human label, e.g. "Martes 21 abr". */
  day_label: string;
};

type HoyResponse = {
  widget_id: "hoy";
  size: "S";
  data: HoyData;
  generated_at: string;
};

type HoyErrorCode = "invalid_params";

type HoyErrorBody = { error: { code: HoyErrorCode; message: string } };

const STATUS_BY_CODE: Record<HoyErrorCode, number> = {
  invalid_params: 422,
};

function errorResult(code: HoyErrorCode, message: string): WidgetHandlerResult {
  const body: HoyErrorBody = { error: { code, message } };
  return { body, status: STATUS_BY_CODE[code] };
}

// ---------------------------------------------------------------------------
// Bogota-aware date helpers. Colombia has no DST → fixed UTC-5 offset. We
// keep the wall-clock math in JS millis to avoid `Date#getXxx` surprises at
// month boundaries, then hand Postgres only a stable date string.
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
 * Capitalizes the first grapheme of `s`. Intentionally simple — day labels
 * are always Spanish weekday names, never emoji / RTL / surrogate-pair text.
 */
function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Returns "Martes 21 abr" style label for `now` in Bogota. Uses
 * `Intl.DateTimeFormat` because the project doesn't ship date-fns.
 *
 * We build from `formatToParts` rather than reading a single formatted string
 * so we can:
 *   - capitalize the weekday (es-CO returns lowercase),
 *   - drop the connective "," and "de " so the output matches the spec.
 */
export function formatDayLabel(now: Date): string {
  const fmt = new Intl.DateTimeFormat("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: BOGOTA_TZ,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = capitalize(get("weekday"));
  const day = get("day");
  // Some ICU builds append a trailing "." to the short month ("abr."). The
  // spec calls for "abr" without punctuation, so strip it uniformly.
  const month = get("month").replace(/\.$/, "");
  return `${weekday} ${day} ${month}`;
}

// ---------------------------------------------------------------------------
// SQL expression shared by both aggregation queries — converts native cents
// to COP cents using the current TRM, so COP-only users pay nothing for the
// USD path. Kept inline (not in money.ts) because it mixes SQL and JS state:
// the rate comes from JS and drops into the query as a literal.
// ---------------------------------------------------------------------------

// Bogota date of a tx — applies the timezone at Postgres so a tx at
// 23:30 Bogota (which is 04:30 UTC the next day) still lands on the
// Bogota "yesterday" when we compare.
const txBogotaDateSql = sql`((${transactions.occurredAt}) AT TIME ZONE ${sql.raw(
  `'${BOGOTA_TZ}'`,
)})::date`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const hoyHandler: WidgetHandler = async (ctx) => {
  if (ctx.size !== "S") {
    return errorResult("invalid_params", "hoy only supports size S");
  }

  const now = new Date();
  const today = nowInBogota(now);
  const todayStr = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const firstOfMonthStr = `${today.year}-${String(today.month).padStart(2, "0")}-01`;

  // The MTD range in SQL uses `occurredAt >= startOfMonthUtc AND < startOfNextMonthUtc`
  // AS A PRE-FILTER so the index on `(user_id, occurred_at)` helps; the
  // Bogota-date comparison in the CASE WHEN refines it. The pre-filter is
  // deliberately generous by the TZ offset so a 23:59 Bogota tx on the last
  // day of the month (04:59 UTC next day) isn't missed.
  const prefilterStart = new Date(Date.UTC(today.year, today.month - 1, 1) - BOGOTA_OFFSET_MS);
  const prefilterEnd = new Date(Date.UTC(today.year, today.month, 1) + 24 * 60 * 60 * 1000);

  // One round-trip: per-currency totals split into "today" vs "MTD-before-today".
  // Keeping it in a single query avoids a second index scan and a second FX
  // fetch. Sums are always ABSOLUTE (we pre-negate) so callers just add.
  const rows = await db
    .select({
      currency: transactions.currency,
      spentTodayCents: sql<string>`
        COALESCE(
          SUM(
            CASE
              WHEN ${txBogotaDateSql} = ${todayStr}::date
                AND ${transactions.amountCents} < 0
              THEN -${transactions.amountCents}
              ELSE 0
            END
          ),
          0
        )
      `,
      txCountToday: sql<string>`
        COALESCE(
          SUM(
            CASE
              WHEN ${txBogotaDateSql} = ${todayStr}::date
                AND ${transactions.amountCents} < 0
              THEN 1
              ELSE 0
            END
          ),
          0
        )
      `,
      spentPriorMtdCents: sql<string>`
        COALESCE(
          SUM(
            CASE
              WHEN ${txBogotaDateSql} >= ${firstOfMonthStr}::date
                AND ${txBogotaDateSql} < ${todayStr}::date
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
        // Exclusions — see file header for the rationale.
        notDeleted(transactions.deletedAt),
        notAdjustment(transactions.isAdjustment),
        sql`${transactions.source} <> 'balance_adjustment'`,
        sql`${transactions.channel} <> 'transfer'`,
      ),
    )
    .groupBy(transactions.currency);

  // FX is only fetched when at least one USD row survived the filters —
  // same optimization as `mis-tcs`. The fallback of 0 is safe because
  // `toCop` won't be called for COP rows, and a 0 rate on USD rows would
  // drop them silently, which is preferable to crashing.
  const needsFx = rows.some(
    (r) =>
      r.currency === "USD" &&
      (BigInt(r.spentTodayCents) !== BigInt(0) || BigInt(r.spentPriorMtdCents) !== BigInt(0)),
  );
  const fxRate = needsFx ? (await getCurrentFxRate()).rate : 0;

  let spentTodayCopCents = BigInt(0);
  let spentPriorMtdCopCents = BigInt(0);
  let txCountToday = 0;
  for (const r of rows) {
    const currency = r.currency as Currency;
    spentTodayCopCents += toCop(BigInt(r.spentTodayCents), currency, fxRate);
    spentPriorMtdCopCents += toCop(BigInt(r.spentPriorMtdCents), currency, fxRate);
    // tx_count is a pure count — same across all currencies, just summed.
    txCountToday += Number(r.txCountToday);
  }

  const spentCop = centsToCop(spentTodayCopCents);

  // Compare vs MTD daily average. Day 1 → null (no prior days).
  let vsDailyAvgPct: number | null;
  if (today.day === 1) {
    vsDailyAvgPct = null;
  } else {
    const priorDays = today.day - 1;
    // Keep the division in Number-space (we're dividing small COP-pesos
    // counts, never within the hot path of balance math).
    const priorMtdCop = centsToCop(spentPriorMtdCopCents);
    const avgDaily = priorMtdCop / priorDays;
    if (avgDaily === 0) {
      // No prior spend to compare against. The cleanest signal is null —
      // "infinite percent over 0" is not information the tile can render.
      vsDailyAvgPct = spentCop === 0 ? 0 : null;
    } else {
      vsDailyAvgPct = Math.round((spentCop / avgDaily - 1) * 100);
    }
  }

  const body: HoyResponse = {
    widget_id: "hoy",
    size: "S",
    data: {
      spent_cop: spentCop,
      tx_count: txCountToday,
      vs_daily_avg_pct: vsDailyAvgPct,
      day_label: formatDayLabel(now),
    },
    generated_at: bogotaIsoNow(now),
  };
  return { body };
};
