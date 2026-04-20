import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  DEFAULT_DISPLAY_CURRENCY_MODE,
  DISPLAY_CURRENCY_MODES,
  type DisplayCurrencyMode,
  type UiPreferences,
  users,
} from "@/lib/db/schema";

export type ResolvedUiPreferences = {
  displayCurrencyMode: DisplayCurrencyMode;
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
  const mode = raw.displayCurrencyMode;
  return {
    displayCurrencyMode:
      mode && (DISPLAY_CURRENCY_MODES as readonly string[]).includes(mode)
        ? mode
        : DEFAULT_DISPLAY_CURRENCY_MODE,
  };
}
