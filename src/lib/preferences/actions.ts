"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { counterparties, DISPLAY_CURRENCY_MODES, FINANCIAL_CYCLE_MODES } from "@/lib/db/schema";
import { updateUiPreferences } from "./repo";

export async function setDisplayCurrencyMode(mode: unknown): Promise<void> {
  const session = await getSessionUser();
  const parsed = z.enum(DISPLAY_CURRENCY_MODES).parse(mode);
  await updateUiPreferences(session.id, { displayCurrencyMode: parsed });
  revalidatePath("/", "layout");
}

export async function setFinancialCycleMode(mode: unknown): Promise<void> {
  const session = await getSessionUser();
  const parsed = z.enum(FINANCIAL_CYCLE_MODES).parse(mode);
  await updateUiPreferences(session.id, { financialCycleMode: parsed });
  // The cycle mode affects the dashboard, budgets and insights views — bust
  // the layout cache so all three pages re-render with the new boundaries.
  revalidatePath("/", "layout");
}

export async function dismissPayPeriodNudge(): Promise<void> {
  const session = await getSessionUser();
  await updateUiPreferences(session.id, { payPeriodNudgeDismissed: true });
  revalidatePath("/");
}

const counterpartySalaryToggleSchema = z.object({
  counterpartyId: z.coerce.number().int().positive(),
  isSalary: z.boolean(),
});

/**
 * Slim toggle for `counterparties.isSalary` from the Settings UI. Scoped to
 * the calling user so a leaked counterparty id can't be flipped on someone
 * else's row.
 */
export async function setCounterpartyIsSalary(input: unknown): Promise<void> {
  const session = await getSessionUser();
  const { counterpartyId, isSalary } = counterpartySalaryToggleSchema.parse(input);
  await db
    .update(counterparties)
    .set({ isSalary, updatedAt: new Date() })
    .where(and(eq(counterparties.userId, session.id), eq(counterparties.id, counterpartyId)));
  revalidatePath("/settings/period");
  revalidatePath("/", "layout");
}
