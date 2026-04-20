"use client";

import { TriangleAlertIcon } from "lucide-react";
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
