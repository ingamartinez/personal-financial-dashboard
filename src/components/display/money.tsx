"use client";

import { cn } from "@/lib/utils";
import { convertCents, displayCurrencyFor, formatMoney } from "@/lib/money";
import type { Currency } from "@/lib/types";
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
  return (
    <span className={className}>
      {formatMoney(converted, target)}
      <span className={cn("text-muted-foreground ml-1 text-xs font-normal", footnoteClassName)}>
        ≈ {formatMoney(cents, currency)}
      </span>
    </span>
  );
}
