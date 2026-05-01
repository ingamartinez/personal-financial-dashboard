import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, recurringTransactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { formatAccountLabel } from "@/lib/accounts/format";
import { convertToDisplayCurrency, type MoneyAmount } from "@/lib/fx/convert";
import { sumByDisplayCurrency, type AggregationBucket } from "@/lib/fx/aggregate";
import { detectPriceHike, type PriceHike } from "@/lib/recurring/price-hike-detector";
import type { DisplayCurrencyMode } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubscriptionRow {
  id: number;
  label: string;
  accountLabel: string;
  /** Native cents, bigint, signed negative for expenses. */
  amountCents: bigint;
  currency: string;
  dayOfMonth: number;
  amountType: "fixed" | "variable";
  /** null when categorySlug is null on the row */
  categorySlug: string | null;
  categoryName: string | null;
  notes: string | null;
  skippedMonths: string[];
  /** Next occurrence date as ISO yyyy-mm-dd */
  nextOccurrence: string;
  /**
   * Annual projection in native cents (amountCents × 12).
   * Expenses are stored as negative — this preserves the sign.
   */
  annualCents: bigint;
  /** Display-currency-converted amount for the row (used for sort + display). */
  displayAmount: MoneyAmount;
  /** Absolute display-currency amount for sort ranking (desc). */
  displayAmountAbsCents: bigint;
  /**
   * Populated when a qualifying price hike is detected for this subscription.
   * Always null for variable-type rows.
   */
  priceHike: PriceHike | null;
}

export type { PriceHike };

export interface SubscriptionsSummary {
  rows: SubscriptionRow[];
  /** sumByDisplayCurrency over all rows for the monthly total. */
  monthlyTotals: AggregationBucket[];
  /** sumByDisplayCurrency over all rows × 12 for the annual projection. */
  annualTotals: AggregationBucket[];
}

// ---------------------------------------------------------------------------
// Next-occurrence helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Compute the next occurrence date (ISO yyyy-mm-dd) for a recurring with the
 * given `dayOfMonth`.
 *
 * Logic:
 *   - If today's day ≤ dayOfMonth → the next occurrence is this month.
 *   - Else → the next occurrence is next month.
 *   - If the computed yyyy-mm is in `skippedMonths`, skip forward by one more
 *     month (repeat until a non-skipped month is found, up to 24 iterations to
 *     avoid infinite loops on pathological data).
 *
 * `today` is injected so the helper is pure and unit-testable without
 * Date mocking. Pass `new Date()` from callers in production.
 */
export function computeNextOccurrence(
  dayOfMonth: number,
  skippedMonths: string[],
  today: Date,
): string {
  const todayDay = today.getUTCDate();
  const skipped = new Set(skippedMonths);

  let year = today.getUTCFullYear();
  let month = today.getUTCMonth() + 1; // 1-12

  if (todayDay > dayOfMonth) {
    // This month's slot already passed — advance to next month.
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  }

  // Walk forward until we find a month not in skippedMonths.
  for (let i = 0; i < 24; i++) {
    const ym = `${year}-${String(month).padStart(2, "0")}`;
    if (!skipped.has(ym)) {
      return `${ym}-${String(dayOfMonth).padStart(2, "0")}`;
    }
    // Advance one more month.
    if (month === 12) {
      year += 1;
      month = 1;
    } else {
      month += 1;
    }
  }

  // Fallback — should never happen with sane data.
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  return `${ym}-${String(dayOfMonth).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Database query
// ---------------------------------------------------------------------------

/**
 * Fetch all active, non-deleted recurring transactions for `userId` whose
 * category slug is 'suscripciones', enriched with next-occurrence + display
 * currency conversion.
 *
 * Sorted by display-currency absolute amount descending (most expensive first).
 */
export async function getSubscriptions(
  userId: number,
  displayCurrencyMode: DisplayCurrencyMode,
  copPerUsd: number,
): Promise<SubscriptionsSummary> {
  const today = new Date();

  const raw = await db
    .select({
      id: recurringTransactions.id,
      label: recurringTransactions.label,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      categorySlug: recurringTransactions.categorySlug,
      dayOfMonth: recurringTransactions.dayOfMonth,
      active: recurringTransactions.active,
      amountType: recurringTransactions.amountType,
      notes: recurringTransactions.notes,
      skippedMonths: recurringTransactions.skippedMonths,
      // Account fields for formatAccountLabel
      accountName: accounts.name,
      accountCurrency: accounts.currency,
      accountInstitution: accounts.institution,
      // Category name (may be null if the category was deleted concurrently —
      // the FK is ON DELETE SET NULL)
      categoryName: categories.name,
    })
    .from(recurringTransactions)
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, recurringTransactions.accountId),
        // tenant safety: accounts also belong to the user
        eq(accounts.userId, userId),
        // exclude soft-archived accounts — their subscriptions must not appear
        notDeleted(accounts.deletedAt),
      ),
    )
    .leftJoin(
      categories,
      and(
        // tenant safety: categories are unique on (user_id, slug) — NEVER join on slug alone
        eq(categories.userId, userId),
        eq(categories.slug, recurringTransactions.categorySlug),
        notDeleted(categories.deletedAt),
      ),
    )
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.active, true),
        eq(recurringTransactions.categorySlug, "suscripciones"),
        notDeleted(recurringTransactions.deletedAt),
      ),
    )
    .orderBy(asc(recurringTransactions.label));

  // Recurring rows have no rawData.fx — use live TRM for display conversion.
  // We pass rawData: {} so convertToDisplayCurrency falls back gracefully:
  // it will skip conversion if currencies already match (COP), and for USD rows
  // it will log fx_conversion_missing_trm and return the original currency.
  // For the subscriptions hub, live-TRM conversion via copPerUsd is better than
  // a frozen-TRM fallback; we apply it here using the same integer math pattern.
  const rows: SubscriptionRow[] = raw.map((r) => {
    const annualCents = r.amountCents * BigInt(12);

    // For recurrings we cannot use frozen TRM (no rawData.fx), so we synthesise
    // an fx block with the live rate so convertToDisplayCurrency can convert.
    // We inject it as rawData.fx with trmSource="user_input" to signal live-rate.
    const syntheticRawData: Record<string, unknown> =
      r.currency !== "COP"
        ? {
            fx: {
              originalCurrency: r.currency,
              originalAmountCents:
                r.amountCents < BigInt(0) ? (-r.amountCents).toString() : r.amountCents.toString(),
              trmToAccountCurrency: copPerUsd,
              trmSource: "user_input",
            },
          }
        : {};

    const displayAmount = convertToDisplayCurrency(
      { amountCents: r.amountCents, currency: r.currency, rawData: syntheticRawData },
      displayCurrencyMode,
    );

    const displayAmountAbsCents =
      displayAmount.cents < BigInt(0) ? -displayAmount.cents : displayAmount.cents;

    const nextOccurrence = computeNextOccurrence(r.dayOfMonth, r.skippedMonths ?? [], today);

    return {
      id: r.id,
      label: r.label,
      accountLabel: formatAccountLabel({
        name: r.accountName,
        currency: r.accountCurrency,
        institution: r.accountInstitution,
      }),
      amountCents: r.amountCents,
      currency: r.currency,
      dayOfMonth: r.dayOfMonth,
      amountType: r.amountType,
      categorySlug: r.categorySlug,
      categoryName: r.categoryName ?? null,
      notes: r.notes ?? null,
      skippedMonths: r.skippedMonths ?? [],
      nextOccurrence,
      annualCents,
      displayAmount,
      displayAmountAbsCents,
      // Enriched below in a second pass.
      priceHike: null,
    };
  });

  // ── Price-hike enrichment pass (#701) ──────────────────────────────────────
  // For each non-variable row, fetch the last 4 observations and run the
  // detector. Scoped to userId on both the observation row and the recurring FK.
  // We batch all observation queries into a single window-function query to
  // avoid N+1 per row.
  if (raw.length > 0) {
    // Fetch last 4 observations per recurring for all ids in this result set.
    // ROW_NUMBER() OVER (PARTITION BY recurring_id ORDER BY observed_at DESC) ≤ 4.
    const recurringIds = raw.filter((r) => r.amountType !== "variable").map((r) => r.id);

    if (recurringIds.length > 0) {
      const obsRows = await db.execute<{
        recurring_id: number;
        real_amount_cents: string; // pg returns bigint as string
        real_currency: string;
        observed_at: string;
        rn: string;
      }>(sql`
        SELECT recurring_id, real_amount_cents, real_currency, observed_at, rn
        FROM (
          SELECT
            recurring_id,
            real_amount_cents,
            real_currency,
            observed_at,
            ROW_NUMBER() OVER (
              PARTITION BY recurring_id
              ORDER BY observed_at DESC
            ) AS rn
          FROM recurring_link_observations
          WHERE user_id = ${userId}
            AND recurring_id = ANY(${sql.raw(`ARRAY[${recurringIds.join(",")}]::int[]`)})
        ) ranked
        WHERE rn <= 4
        ORDER BY recurring_id, rn
      `);

      // Group by recurringId, most-recent-first (rn=1 is first).
      const obsByRecurring = new Map<
        number,
        {
          realAmountCents: bigint;
          observedAt: Date;
          realCurrency: import("@/lib/types").Currency;
        }[]
      >();
      for (const row of obsRows) {
        const rid = Number(row.recurring_id);
        if (!obsByRecurring.has(rid)) obsByRecurring.set(rid, []);
        obsByRecurring.get(rid)!.push({
          realAmountCents: BigInt(row.real_amount_cents),
          observedAt: new Date(row.observed_at),
          realCurrency: row.real_currency as import("@/lib/types").Currency,
        });
      }

      // Run detector for each non-variable row and attach the result.
      for (const row of rows) {
        if (row.amountType === "variable") continue;
        const obs = obsByRecurring.get(row.id) ?? [];
        row.priceHike = detectPriceHike(row.id, obs);
      }
    }
  }

  // Sort by display-currency absolute amount descending (most expensive first).
  // Stable tiebreaker: ascending id so repeated renders are deterministic.
  rows.sort((a, b) => {
    if (b.displayAmountAbsCents > a.displayAmountAbsCents) return 1;
    if (b.displayAmountAbsCents < a.displayAmountAbsCents) return -1;
    return a.id - b.id;
  });

  // Compute monthly and annual display-currency totals using the ORIGINAL
  // native currency + synthetic fx block per row. Passing displayCurrencyMode
  // (not hardcoded "native") ensures that in all-cop / all-usd mode,
  // sumByDisplayCurrency coerces all rows into one bucket instead of producing
  // one bucket per distinct native currency.
  //
  // We must NOT pass already-converted displayAmount here — let
  // sumByDisplayCurrency be the single authoritative conversion pass so the
  // math stays consistent with the per-row displayAmount values.
  const monthlyRows = raw.map((r) => {
    const syntheticRawData: Record<string, unknown> =
      r.currency !== "COP"
        ? {
            fx: {
              originalCurrency: r.currency,
              originalAmountCents:
                r.amountCents < BigInt(0) ? (-r.amountCents).toString() : r.amountCents.toString(),
              trmToAccountCurrency: copPerUsd,
              trmSource: "user_input",
            },
          }
        : {};
    return {
      amountCents: r.amountCents,
      currency: r.currency,
      rawData: syntheticRawData,
    };
  });

  const annualRows = monthlyRows.map((r) => ({
    ...r,
    amountCents: r.amountCents * BigInt(12),
  }));

  const monthlyTotals = sumByDisplayCurrency(monthlyRows, displayCurrencyMode);
  const annualTotals = sumByDisplayCurrency(annualRows, displayCurrencyMode);

  return { rows, monthlyTotals, annualTotals };
}
