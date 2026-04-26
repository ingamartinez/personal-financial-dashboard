import { createLogger } from "@/lib/logger";
import type { DisplayCurrencyMode } from "@/lib/db/schema";
import { displayCurrencyFor } from "@/lib/money";
import { extractFxMetadataWithFallback } from "@/lib/types/fx-metadata";

const log = createLogger({ module: "fx/convert" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisplayCurrency = "USD" | "COP" | "USDc";

export interface MoneyAmount {
  cents: bigint;
  currency: DisplayCurrency;
  /** True when conversion was applied using frozen TRM from tx metadata. */
  converted: boolean;
  /** TRM that was used, in COP per 1 unit of source currency. null when no conversion. */
  appliedTrm: number | null;
}

/** Minimal tx shape for display conversion. */
export interface TxForConversion {
  amountCents: bigint;
  /** The transaction's native currency (e.g. "USD", "COP", "USDc"). */
  currency: string;
  rawData: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------

/**
 * Convert a transaction's amount to the requested display currency using the
 * FROZEN TRM stored in `rawData.fx.trmToAccountCurrency` — not the live rate.
 *
 * Rules:
 *  1. If `tx.currency === displayCurrency` → return as-is, no conversion.
 *  2. Else: read frozen TRM from rawData.fx (merged_statement first, then primary).
 *  3. If frozen TRM available: convert using INTEGER arithmetic only.
 *     (TRM is stored as COP per 1 USD/USDc, so multiply by TRM × 100 to preserve cents.)
 *  4. If frozen TRM NOT available: log `fx_conversion_missing_trm` and fall back
 *     to `tx.amountCents` unchanged with the ORIGINAL currency (the caller must
 *     render a fallback indicator).
 *
 * Why integer arithmetic:
 *   TRM values like 4123.45 COP/USD must be applied to cents. Rather than using
 *   floats (which drift on large amounts), we scale TRM to micros:
 *     trmMicros = Math.round(trmToAccountCurrency * 1_000_000)
 *     convertedCents = (amountCents * trmMicros) / 1_000_000n   ← BigInt integer division
 *
 * This matches the pattern in money.ts:convertCents and toCop.
 */
export function convertToDisplayCurrency(
  tx: TxForConversion,
  displayCurrencyMode: DisplayCurrencyMode,
): MoneyAmount {
  // Work with string-typed currency to support "USDc" (not in the DB Currency enum
  // but used in ARQ rawData.fx.originalCurrency). Cast only at output boundaries.
  const nativeCurrencyStr = tx.currency;

  // displayCurrencyFor requires Currency ("COP"|"USD"), so map "USDc" → "USD" for routing.
  // USDc is functionally USD for display conversion purposes (1:1 account currency).
  const routingCurrency =
    nativeCurrencyStr === "USDc" ? "USD" : (nativeCurrencyStr as "COP" | "USD");
  const targetCurrencyStr =
    displayCurrencyMode === "native"
      ? nativeCurrencyStr
      : displayCurrencyFor(displayCurrencyMode, routingCurrency);

  // No conversion needed.
  if (nativeCurrencyStr === targetCurrencyStr || displayCurrencyMode === "native") {
    return {
      cents: tx.amountCents,
      currency: nativeCurrencyStr as DisplayCurrency,
      converted: false,
      appliedTrm: null,
    };
  }

  // Read frozen TRM from tx metadata.
  const fx = extractFxMetadataWithFallback(tx.rawData);

  if (!fx || fx.trmToAccountCurrency === null || fx.trmToAccountCurrency <= 0) {
    log.warn(
      {
        currency: nativeCurrencyStr,
        targetCurrency: targetCurrencyStr,
        hasFx: !!fx,
        trmValue: fx?.trmToAccountCurrency ?? null,
        event: "fx_conversion_missing_trm",
      },
      "frozen TRM unavailable for cross-currency conversion — displaying in original currency",
    );
    // Fall back: return unchanged with original currency so the caller can render
    // a "no-TRM" indicator rather than silently showing a wrong value.
    return {
      cents: tx.amountCents,
      currency: nativeCurrencyStr as DisplayCurrency,
      converted: false,
      appliedTrm: null,
    };
  }

  const trm = fx.trmToAccountCurrency;

  // Integer arithmetic: scale TRM to micros, multiply, then divide back.
  const trmMicros = BigInt(Math.round(trm * 1_000_000));
  let convertedCents: bigint;

  const isUsdish = nativeCurrencyStr === "USD" || nativeCurrencyStr === "USDc";

  if (isUsdish) {
    if (targetCurrencyStr === "COP") {
      // USD/USDc → COP: multiply by TRM.
      const absResult = (absBI(tx.amountCents) * trmMicros) / BigInt(1_000_000);
      convertedCents = tx.amountCents < BigInt(0) ? -absResult : absResult;
    } else {
      // USD → USD or unknown: pass-through.
      convertedCents = tx.amountCents;
    }
  } else if (nativeCurrencyStr === "COP") {
    if (targetCurrencyStr === "USD") {
      // COP → USD: divide by TRM.
      const absResult = (absBI(tx.amountCents) * BigInt(1_000_000)) / trmMicros;
      convertedCents = tx.amountCents < BigInt(0) ? -absResult : absResult;
    } else {
      convertedCents = tx.amountCents;
    }
  } else {
    // Unsupported pair — pass through.
    convertedCents = tx.amountCents;
  }

  return {
    cents: convertedCents,
    currency: targetCurrencyStr as DisplayCurrency,
    converted: true,
    appliedTrm: trm,
  };
}

function absBI(n: bigint): bigint {
  return n < BigInt(0) ? -n : n;
}
