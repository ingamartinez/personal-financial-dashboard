import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS = 30;
const MIN_SAME_DIRECTION = 3;

export interface RecurringAdjustmentInsight {
  kind: "recurring_same_direction_adjustments";
  direction: "in" | "out";
  count: number;
  totalCents: bigint;
  message: string;
  windowDays: number;
}

/**
 * Fires when a user has ≥3 adjustments in the last 30 days that are ALL
 * in the same direction. That's a strong signal that the parser is
 * systematically dropping or double-counting a specific pattern, and
 * the user keeps nudging findash back into reality through balance
 * adjustments.
 *
 * Mixed-direction adjustments are noise (normal correction traffic);
 * only uniform-direction streaks get promoted to an insight.
 *
 * Returns `null` when there's no signal.
 */
export async function detectRecurringAdjustmentInsight(
  userId: number,
  now: Date = new Date(),
): Promise<RecurringAdjustmentInsight | null> {
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);

  const rows = await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.isAdjustment, true),
        gte(transactions.occurredAt, cutoff),
        notDeleted(transactions.deletedAt),
      ),
    );

  if (rows.length < MIN_SAME_DIRECTION) return null;

  let allPositive = true;
  let allNegative = true;
  let total = BigInt(0);
  for (const row of rows) {
    total += row.amountCents;
    if (row.amountCents <= BigInt(0)) allPositive = false;
    if (row.amountCents >= BigInt(0)) allNegative = false;
  }

  if (!allPositive && !allNegative) return null;

  const direction: "in" | "out" = allPositive ? "in" : "out";
  const absolute = total < BigInt(0) ? -total : total;
  const message = buildMessage(direction, rows.length, absolute);

  return {
    kind: "recurring_same_direction_adjustments",
    direction,
    count: rows.length,
    totalCents: total,
    message,
    windowDays: WINDOW_DAYS,
  };
}

function buildMessage(direction: "in" | "out", count: number, absoluteCents: bigint): string {
  const major = (absoluteCents / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const arrow = direction === "in" ? "↑ adding" : "↓ subtracting";
  return (
    `${count} adjustments in 30 days, all ${arrow} money (total $${major}).` +
    ` Findash is likely ${direction === "in" ? "missing inbound" : "double-counting outbound"} traffic — check recent parser behavior.`
  );
}
