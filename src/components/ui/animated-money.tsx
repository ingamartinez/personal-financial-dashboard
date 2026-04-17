"use client";

import NumberFlow from "@number-flow/react";
import type { Currency } from "@/lib/types";

export function AnimatedMoney({
  cents,
  currency,
  className,
  signDisplay = "auto",
}: {
  cents: bigint;
  currency: Currency;
  className?: string;
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
}) {
  const locale = currency === "USD" ? "en-US" : "es-CO";
  const maximumFractionDigits = currency === "USD" ? 2 : 0;
  const value = Number(cents) / 100;

  return (
    <NumberFlow
      value={value}
      locales={locale}
      format={{
        style: "currency",
        currency,
        maximumFractionDigits,
        signDisplay,
      }}
      className={className}
    />
  );
}
