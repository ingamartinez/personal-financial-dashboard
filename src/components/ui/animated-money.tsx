"use client";

import NumberFlow from "@number-flow/react";
import { useMoneyMode } from "@/components/display/money-mode-provider";
import { convertCents, displayCurrencyFor, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Currency } from "@/lib/types";

export function AnimatedMoney({
  cents,
  currency,
  className,
  footnoteClassName,
  signDisplay = "auto",
}: {
  cents: bigint;
  currency: Currency;
  className?: string;
  footnoteClassName?: string;
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
}) {
  const { mode, fxRate } = useMoneyMode();
  const target = displayCurrencyFor(mode, currency);
  const active =
    target === currency || fxRate === null
      ? { cents, currency }
      : { cents: convertCents(cents, currency, target, fxRate.rate), currency: target };

  const locale = active.currency === "USD" ? "en-US" : "es-CO";
  const maximumFractionDigits = active.currency === "USD" ? 2 : 0;
  const value = Number(active.cents) / 100;

  const number = (
    <NumberFlow
      value={value}
      locales={locale}
      format={{
        style: "currency",
        currency: active.currency,
        maximumFractionDigits,
        signDisplay,
      }}
      className={className}
    />
  );

  if (active.currency === currency) return number;

  return (
    <span className="inline-flex items-baseline">
      {number}
      <span className={cn("text-muted-foreground ml-1 text-xs font-normal", footnoteClassName)}>
        ≈ {formatMoney(cents, currency)}
      </span>
    </span>
  );
}
