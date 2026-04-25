import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { counterparties, transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";
import { getUiPreferences } from "@/lib/preferences/repo";
import type { FinancialPeriod, FinancialPeriodFallback } from "./period-format";

// Re-export so existing server-side callers can keep importing types from
// `./period`. Client components must import from `./period-format` to avoid
// dragging this module's db chain into the browser bundle.
export type { FinancialPeriod, FinancialPeriodFallback } from "./period-format";
export { formatPeriodDateRange, periodFallbackNote } from "./period-format";

/**
 * Calendar-month range — used wherever bank truth matters (TC statements,
 * cuotas, próximo pago, fechas de corte, extractos). DO NOT replace with
 * `getFinancialPeriod` for these flows; the calendar boundary is the bank's
 * billing boundary, not the user's.
 */
export function currentCalendarMonth(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

type SalaryTx = {
  occurredAt: Date;
  amountCents: bigint;
  counterpartyId: number;
};

async function loadSalaryTxs(userId: number): Promise<SalaryTx[]> {
  const rows = await db
    .select({
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      counterpartyId: transactions.counterpartyId,
    })
    .from(transactions)
    .innerJoin(
      counterparties,
      and(
        eq(counterparties.id, transactions.counterpartyId),
        // Tenant safety: pair the JOIN by user_id too. A counterparty.id
        // shouldn't ever cross tenants (FK to users), but pairing makes the
        // intent explicit and CodeQL-friendly.
        eq(counterparties.userId, transactions.userId),
      ),
    )
    .where(
      and(
        eq(transactions.userId, userId),
        eq(counterparties.isSalary, true),
        sql`${transactions.amountCents} > 0`,
        notAdjustment(transactions.isAdjustment),
        notDeleted(transactions.deletedAt),
      ),
    )
    .orderBy(transactions.occurredAt);

  return rows
    .filter(
      (r): r is { occurredAt: Date; amountCents: bigint; counterpartyId: number } =>
        r.counterpartyId !== null,
    )
    .map((r) => ({
      occurredAt: r.occurredAt,
      amountCents: r.amountCents,
      counterpartyId: r.counterpartyId,
    }));
}

function medianAmountByCounterparty(txs: readonly SalaryTx[]): Map<number, bigint> {
  const grouped = new Map<number, bigint[]>();
  for (const t of txs) {
    const list = grouped.get(t.counterpartyId);
    if (list) list.push(t.amountCents);
    else grouped.set(t.counterpartyId, [t.amountCents]);
  }
  const medians = new Map<number, bigint>();
  for (const [cpId, amounts] of grouped) {
    const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    medians.set(cpId, sorted[Math.floor(sorted.length / 2)]);
  }
  return medians;
}

/**
 * Filter salary-counterparty txs to "real paychecks" — drop reimbursements,
 * refunds, partial bonuses below 50% of the historical median for that
 * counterparty. Threshold 50% chosen empirically: real paycheck variance is
 * usually <30% (overtime, bonuses), and reimbursements are typically <20%
 * of a paycheck. 50% leaves headroom on both sides.
 */
function filterPaychecks(txs: readonly SalaryTx[], medians: Map<number, bigint>): SalaryTx[] {
  return txs.filter((t) => {
    const median = medians.get(t.counterpartyId);
    if (!median) return false;
    // amount >= 0.5 * median  ⇔  2 * amount >= median  (avoids fractional bigint)
    return t.amountCents * BigInt(2) >= median;
  });
}

function medianSpacingMs(paychecks: readonly SalaryTx[]): number | null {
  if (paychecks.length < 2) return null;
  const sorted = [...paychecks].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    diffs.push(sorted[i].occurredAt.getTime() - sorted[i - 1].occurredAt.getTime());
  }
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/**
 * Find the paycheck whose date is closest to `target`, within `maxDistMs`.
 * Returns null if no paycheck falls inside the window — caller decides
 * whether to fall back to calendar or project.
 *
 * This is the core anchoring rule: a paycheck "anchors" a month boundary
 * when it's the closest one to that boundary. Each paycheck claims at most
 * one month boundary (because `maxDistMs` is half-spacing; two boundaries
 * can't both be closest to the same paycheck).
 */
function nearestAnchor(
  paychecks: readonly SalaryTx[],
  target: Date,
  maxDistMs: number,
): Date | null {
  let best: Date | null = null;
  let bestDist = Infinity;
  const tt = target.getTime();
  for (const p of paychecks) {
    const d = Math.abs(p.occurredAt.getTime() - tt);
    if (d < bestDist && d <= maxDistMs) {
      bestDist = d;
      best = p.occurredAt;
    }
  }
  return best;
}

/**
 * Resolve the financial period for the calendar month containing `now`.
 *
 * Decision flow:
 *  1. If user pref `financialCycleMode = "calendar"` → return calendar range.
 *  2. Load all salary-flagged-counterparty positive transactions for `userId`.
 *  3. Filter to "real paychecks" via per-counterparty median amount (≥50%).
 *  4. Anchor the period bounds on the paychecks closest to monthStart and
 *     nextMonthStart, within ±0.75 * medianSpacing of each boundary.
 *  5. Graceful degradation: if any step fails, return calendar with a
 *     `fallbackReason` so the UI can show an inline note. The setting itself
 *     is not flipped — degradation is per-call, per-month.
 *
 * The "current month with no future paycheck yet" case is handled by
 * projecting `end = start + medianSpacing` when (a) the wall clock is inside
 * the queried month and (b) `start` resolved successfully but `end` did not.
 *
 * `wallNow` is the actual current time used for the "current month" check.
 * Defaults to `Date.now()`; injectable for deterministic tests since Bun's
 * vitest does not support `vi.setSystemTime`.
 */
export async function getFinancialPeriod(
  userId: number,
  now = new Date(),
  wallNow: number = Date.now(),
): Promise<FinancialPeriod> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const calendar = (reason?: FinancialPeriodFallback): FinancialPeriod => ({
    start: monthStart,
    end: nextMonthStart,
    mode: "calendar",
    ...(reason ? { fallbackReason: reason } : {}),
  });

  const prefs = await getUiPreferences(userId);
  if (prefs.financialCycleMode === "calendar") return calendar();

  const all = await loadSalaryTxs(userId);
  if (all.length === 0) return calendar("no_salary_flagged");

  const medians = medianAmountByCounterparty(all);
  const paychecks = filterPaychecks(all, medians);
  if (paychecks.length < 2) return calendar("insufficient_history");

  const spacingMs = medianSpacingMs(paychecks);
  if (!spacingMs) return calendar("insufficient_history");
  const anchorWindow = spacingMs * 0.75;

  const start = nearestAnchor(paychecks, monthStart, anchorWindow);
  if (!start) return calendar("no_recent_paycheck");

  const end = nearestAnchor(paychecks, nextMonthStart, anchorWindow);

  if (!end || end.getTime() <= start.getTime()) {
    // No anchor for the next month boundary. Two cases:
    //  - Current month, next paycheck not yet landed → project from spacing.
    //  - Past month with sparse data → fall back to calendar.
    const isCurrent = wallNow >= monthStart.getTime() && wallNow < nextMonthStart.getTime();
    if (isCurrent) {
      return {
        start,
        end: new Date(start.getTime() + spacingMs),
        mode: "pay_period",
      };
    }
    return calendar("insufficient_history");
  }

  return { start, end, mode: "pay_period" };
}

/**
 * Pre-conditions for activating `pay_period` mode in Settings UI. Returns
 * which gates the user has met / failed so the toggle can be enabled and
 * the failure reason explained inline.
 */
export type PayPeriodReadiness = {
  ready: boolean;
  hasSalaryFlag: boolean;
  paycheckCount: number;
};

export async function getPayPeriodReadiness(userId: number): Promise<PayPeriodReadiness> {
  const txs = await loadSalaryTxs(userId);
  const hasSalaryFlag = txs.length > 0;
  const medians = medianAmountByCounterparty(txs);
  const paychecks = filterPaychecks(txs, medians);
  return {
    hasSalaryFlag,
    paycheckCount: paychecks.length,
    ready: hasSalaryFlag && paychecks.length >= 2,
  };
}

/**
 * Counterparties that have at least one positive transaction (income), with
 * their `isSalary` flag and rolled-up income stats. Drives the Settings UI's
 * "Sueldos" list — users flag the right counterparty(ies) without scrolling
 * past every merchant they've ever paid.
 */
export type SalaryCandidate = {
  id: number;
  displayName: string;
  isSalary: boolean;
  incomeTxCount: number;
  totalIncomeCents: bigint;
};

export async function listSalaryCandidates(userId: number): Promise<SalaryCandidate[]> {
  const rows = await db
    .select({
      id: counterparties.id,
      displayName: counterparties.displayName,
      isSalary: counterparties.isSalary,
      incomeTxCount: sql<number>`COUNT(${transactions.id})::int`,
      totalIncomeCents: sql<string>`COALESCE(SUM(${transactions.amountCents}), 0)`,
    })
    .from(counterparties)
    .innerJoin(
      transactions,
      and(
        eq(transactions.counterpartyId, counterparties.id),
        eq(transactions.userId, counterparties.userId),
      ),
    )
    .where(
      and(
        eq(counterparties.userId, userId),
        sql`${transactions.amountCents} > 0`,
        notAdjustment(transactions.isAdjustment),
        notDeleted(transactions.deletedAt),
      ),
    )
    .groupBy(counterparties.id, counterparties.displayName, counterparties.isSalary)
    .orderBy(sql`SUM(${transactions.amountCents}) DESC`);

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    isSalary: r.isSalary,
    incomeTxCount: r.incomeTxCount,
    totalIncomeCents: BigInt(r.totalIncomeCents),
  }));
}
