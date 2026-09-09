import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * Resolves whether the TC accounting layer is enabled for this user.
 *
 * Priority:
 *   1. users.featureFlags.tcAccountingEnabled (per-user override) — wins if set
 *   2. process.env.TC_ACCOUNTING_ENABLED === "true" (global default)
 *
 * Defaults to OFF so the product stays on expense tracking unless the owner
 * explicitly opts back into bank-accurate ledger behavior (#815).
 */
export async function isTcAccountingEnabled(userId: number): Promise<boolean> {
  const rows = await db
    .select({ flags: users.featureFlags })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const perUser = rows[0]?.flags?.tcAccountingEnabled;
  if (perUser !== undefined) return perUser;
  return process.env.TC_ACCOUNTING_ENABLED === "true";
}

export async function writeTcAccountingEnabled(userId: number, enabled: boolean): Promise<void> {
  const [row] = await db
    .update(users)
    .set({
      featureFlags: sql`${users.featureFlags} || ${JSON.stringify({ tcAccountingEnabled: enabled })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!row) throw new Error(`User ${userId} not found`);
}
