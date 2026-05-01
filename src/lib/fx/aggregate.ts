import {
  convertToDisplayCurrency,
  type DisplayCurrency,
  type TxForConversion,
} from "@/lib/fx/convert";
import { displayCurrencyFor } from "@/lib/money";
import type { DisplayCurrencyMode } from "@/lib/db/schema";
import type { Currency } from "@/lib/types";

// ---------------------------------------------------------------------------
// Aggregation primitives — sum bigint cents across rows respecting the user's
// `displayCurrencyMode` and each row's frozen TRM (`rawData.fx`). Designed to
// replace SQL `SUM(amount_cents) GROUP BY currency` patterns that silently
// rewrite history with today's TRM.
//
// SAME helper that powers `MoneyFrozen` — the row-level math is exactly
// `convertToDisplayCurrency`, so any visual mismatch between the table and a
// summary becomes a single-source-of-truth bug, not a divergence.
//
// Designed for /budgets and /insights. Volume is ~500 rows/month/user → JS
// aggregation is fine and trades a small payload increase for the clarity of
// not duplicating FX logic in SQL.
// ---------------------------------------------------------------------------

export interface AggregationBucket {
  /** Display currency for this bucket. Equals row currency in native mode. */
  currency: DisplayCurrency;
  /** Summed amount in `currency`, integer cents. Sign-preserving. */
  cents: bigint;
  /** Number of rows that landed in this bucket. */
  txCount: number;
  /** Rows where conversion was needed but the frozen TRM was missing. */
  missingTrmCount: number;
  /** Rows where frozen TRM was applied successfully. Drives "convertido" UX. */
  convertedCount: number;
}

function resolveTargetCurrency(nativeCurrency: string, mode: DisplayCurrencyMode): string {
  if (mode === "native") return nativeCurrency;
  // `displayCurrencyFor` only knows the strict Currency enum ("COP" | "USD").
  // USDc (a USD-denominated cents-style internal currency) routes via USD.
  const routing = nativeCurrency === "USDc" ? "USD" : (nativeCurrency as Currency);
  return displayCurrencyFor(mode, routing);
}

/**
 * Aggregate a flat row set into one bucket per display currency.
 *
 * In `all-cop` / `all-usd` the result is a single bucket (every row is
 * coerced to the target currency). In `native` you get one bucket per
 * distinct row currency.
 *
 * "Missing TRM" only counts rows where conversion was *needed* (target
 * differs from native) but the row had no frozen TRM. Same-currency rows
 * are not penalised — they just pass through.
 */
export function sumByDisplayCurrency(
  rows: Iterable<TxForConversion>,
  mode: DisplayCurrencyMode,
): AggregationBucket[] {
  const buckets = new Map<string, AggregationBucket>();
  for (const r of rows) {
    const result = convertToDisplayCurrency(r, mode);
    const target = resolveTargetCurrency(r.currency, mode);
    const conversionWasNeeded = target !== r.currency;
    const missingTrm = conversionWasNeeded && !result.converted;

    let bucket = buckets.get(result.currency);
    if (!bucket) {
      bucket = {
        currency: result.currency,
        cents: BigInt(0),
        txCount: 0,
        missingTrmCount: 0,
        convertedCount: 0,
      };
      buckets.set(result.currency, bucket);
    }
    bucket.cents += result.cents;
    bucket.txCount += 1;
    if (missingTrm) bucket.missingTrmCount += 1;
    if (result.converted) bucket.convertedCount += 1;
  }
  return [...buckets.values()];
}

/**
 * Like {@link sumByDisplayCurrency} but groups rows by an arbitrary key first
 * (e.g. category root slug, merchant). Returns `Map<groupKey, buckets[]>`.
 *
 * Rows whose `keyOf(row)` is `null` are skipped (mirrors the SQL semantics
 * where a NULL grouping key drops the row from the result).
 */
export function sumByGroupAndDisplayCurrency<T extends TxForConversion>(
  rows: Iterable<T>,
  mode: DisplayCurrencyMode,
  keyOf: (row: T) => string | null,
): Map<string, AggregationBucket[]> {
  const out = new Map<string, Map<string, AggregationBucket>>();
  for (const r of rows) {
    const groupKey = keyOf(r);
    if (groupKey === null) continue;

    let inner = out.get(groupKey);
    if (!inner) {
      inner = new Map();
      out.set(groupKey, inner);
    }

    const result = convertToDisplayCurrency(r, mode);
    const target = resolveTargetCurrency(r.currency, mode);
    const conversionWasNeeded = target !== r.currency;
    const missingTrm = conversionWasNeeded && !result.converted;

    let bucket = inner.get(result.currency);
    if (!bucket) {
      bucket = {
        currency: result.currency,
        cents: BigInt(0),
        txCount: 0,
        missingTrmCount: 0,
        convertedCount: 0,
      };
      inner.set(result.currency, bucket);
    }
    bucket.cents += result.cents;
    bucket.txCount += 1;
    if (missingTrm) bucket.missingTrmCount += 1;
    if (result.converted) bucket.convertedCount += 1;
  }

  return new Map(Array.from(out.entries()).map(([k, v]) => [k, [...v.values()]]));
}

/**
 * Pick the bucket whose currency matches `target` from a list, or return a
 * zero-bucket in `target` currency. Useful when a caller wants one number per
 * group in a known display currency (e.g. "spent in COP for `food`").
 */
export function pickBucket(
  buckets: ReadonlyArray<AggregationBucket>,
  target: DisplayCurrency,
): AggregationBucket {
  return (
    buckets.find((b) => b.currency === target) ?? {
      currency: target,
      cents: BigInt(0),
      txCount: 0,
      missingTrmCount: 0,
      convertedCount: 0,
    }
  );
}
