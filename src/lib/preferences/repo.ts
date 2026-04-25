import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  DEFAULT_DISPLAY_CURRENCY_MODE,
  DEFAULT_FINANCIAL_CYCLE_MODE,
  DISPLAY_CURRENCY_MODES,
  FINANCIAL_CYCLE_MODES,
  type DisplayCurrencyMode,
  type FinancialCycleMode,
  type UiPreferences,
  users,
} from "@/lib/db/schema";

export type ResolvedUiPreferences = {
  displayCurrencyMode: DisplayCurrencyMode;
  financialCycleMode: FinancialCycleMode;
  payPeriodNudgeDismissed: boolean;
};

export async function getUiPreferences(userId: number): Promise<ResolvedUiPreferences> {
  const [row] = await db
    .select({ prefs: users.uiPreferences })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return resolvePreferences(row?.prefs ?? {});
}

export async function updateUiPreferences(
  userId: number,
  partial: UiPreferences,
): Promise<ResolvedUiPreferences> {
  const [row] = await db
    .update(users)
    .set({
      uiPreferences: sql`${users.uiPreferences} || ${JSON.stringify(partial)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ prefs: users.uiPreferences });
  if (!row) throw new Error(`User ${userId} not found`);
  return resolvePreferences(row.prefs ?? {});
}

function resolvePreferences(raw: UiPreferences): ResolvedUiPreferences {
  const currencyMode = raw.displayCurrencyMode;
  const cycleMode = raw.financialCycleMode;
  return {
    displayCurrencyMode:
      currencyMode && (DISPLAY_CURRENCY_MODES as readonly string[]).includes(currencyMode)
        ? currencyMode
        : DEFAULT_DISPLAY_CURRENCY_MODE,
    financialCycleMode:
      cycleMode && (FINANCIAL_CYCLE_MODES as readonly string[]).includes(cycleMode)
        ? cycleMode
        : DEFAULT_FINANCIAL_CYCLE_MODE,
    payPeriodNudgeDismissed: raw.payPeriodNudgeDismissed === true,
  };
}
