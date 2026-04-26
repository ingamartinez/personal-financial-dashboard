"use client";

import { TriangleAlertIcon, ClockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { convertCents, displayCurrencyFor, formatMoney } from "@/lib/money";
import type { Currency } from "@/lib/types";
import { convertToDisplayCurrency } from "@/lib/fx/convert";
import type { TxForConversion } from "@/lib/fx/convert";
import { useMoneyMode } from "./money-mode-provider";

export function Money({
  cents,
  currency,
  className,
  footnoteClassName,
}: {
  cents: bigint;
  currency: Currency;
  className?: string;
  footnoteClassName?: string;
}) {
  const { mode, fxRate } = useMoneyMode();
  const target = displayCurrencyFor(mode, currency);

  if (target === currency || fxRate === null) {
    return <span className={className}>{formatMoney(cents, currency)}</span>;
  }

  const converted = convertCents(cents, currency, target, fxRate.rate);
  const stale = fxRate.source === "fallback";
  return (
    <span className={className}>
      {formatMoney(converted, target)}
      <span className={cn("text-muted-foreground ml-1 text-xs font-normal", footnoteClassName)}>
        ≈ {formatMoney(cents, currency)}
      </span>
      {stale ? <StaleFxIcon /> : null}
    </span>
  );
}

export function StaleFxIcon({ className }: { className?: string }) {
  return (
    <TriangleAlertIcon
      aria-label="Conversion uses a fallback rate — live TRM unavailable"
      className={cn("ml-1 inline size-3 align-[-1px] text-amber-600", className)}
    />
  );
}

// ---------------------------------------------------------------------------
// MoneyFrozen — uses frozen TRM stored in rawData.fx instead of live rate
// ---------------------------------------------------------------------------

/**
 * Like `<Money>` but reads the frozen TRM from rawData.fx for conversion.
 *
 * When a frozen TRM is available and conversion happened, shows a tooltip
 * "Convertido a {currency} usando TRM histórica". When TRM is missing,
 * falls back to displaying the original amount without conversion.
 *
 * Use this in transaction listings and reports wherever the tx rawData is
 * available — it ensures historical accuracy (issue #519).
 */
export function MoneyFrozen({
  tx,
  className,
  footnoteClassName,
}: {
  tx: TxForConversion;
  className?: string;
  footnoteClassName?: string;
}) {
  const { mode } = useMoneyMode();
  const result = convertToDisplayCurrency(tx, mode);

  if (!result.converted) {
    // Either same currency, native mode, or no TRM available — show as-is.
    return (
      <span className={className}>{formatMoney(result.cents, result.currency as Currency)}</span>
    );
  }

  const originalCurrency = tx.currency as Currency;
  const trmLabel = result.appliedTrm
    ? result.appliedTrm.toLocaleString("es-CO", { maximumFractionDigits: 2 })
    : "?";

  return (
    <span
      className={className}
      title={`Convertido a ${result.currency} usando TRM histórica (${trmLabel} COP/USD)`}
    >
      {formatMoney(result.cents, result.currency as Currency)}
      <span className={cn("text-muted-foreground ml-1 text-xs font-normal", footnoteClassName)}>
        ≈ {formatMoney(tx.amountCents, originalCurrency)}
      </span>
      <FrozenTrmIcon />
    </span>
  );
}

function FrozenTrmIcon({ className }: { className?: string }) {
  return (
    <ClockIcon
      aria-label="Convertido usando TRM histórica"
      className={cn("ml-1 inline size-3 align-[-1px] text-blue-500", className)}
    />
  );
}
