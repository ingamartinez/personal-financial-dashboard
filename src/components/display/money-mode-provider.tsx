"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_DISPLAY_CURRENCY_MODE, type DisplayCurrencyMode } from "@/lib/db/schema";

export type DisplayFxRate = {
  rate: number;
  source: string;
};

export type MoneyModeContextValue = {
  mode: DisplayCurrencyMode;
  fxRate: DisplayFxRate | null;
};

const MoneyModeContext = createContext<MoneyModeContextValue>({
  mode: DEFAULT_DISPLAY_CURRENCY_MODE,
  fxRate: null,
});

export function MoneyModeProvider({
  mode,
  fxRate,
  children,
}: {
  mode: DisplayCurrencyMode;
  fxRate: DisplayFxRate | null;
  children: ReactNode;
}) {
  // No useMemo: the provider lives at (app) layout root, so its re-renders
  // already propagate through the whole client tree — a stable reference
  // wouldn't prevent consumer re-renders in practice.
  const value: MoneyModeContextValue = { mode, fxRate };
  return <MoneyModeContext.Provider value={value}>{children}</MoneyModeContext.Provider>;
}

export function useMoneyMode(): MoneyModeContextValue {
  return useContext(MoneyModeContext);
}
