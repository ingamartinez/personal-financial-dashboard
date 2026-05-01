// #622: Compute forecast occurrences for a given month.
// This module is PURE READ — it NEVER writes to the transactions table.
// Forecast rows are a UI overlay computed at render time from
// recurring_transactions + recurring_gaps. Budgets/insights/balances
// continue to read only real transaction facts.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { notDeleted } from "@/lib/db/helpers";
import { accounts, recurringGaps, recurringTransactions, transactions } from "@/lib/db/schema";
import type { Currency } from "@/lib/types";
import { createLogger } from "@/lib/logger";
import { formatAccountLabel } from "@/lib/accounts/format";

const log = createLogger({ module: "recurring/expected-occurrences" });

// ---------------------------------------------------------------------------
// Types (non-async exports — must NOT be in a "use server" file).
// ---------------------------------------------------------------------------

export type OccurrenceStatus =
  | "esperado" // open gap, not yet past the auto-link window
  | "atrasado" // open gap, past the auto-link window (expectedDate < today - 5d)
  | "linkeado" // covered by a real tx (source != 'recurring')
  | "synthetic" // covered by a synthetic tx (source == 'recurring')
  | "skipped"; // user dismissed this month

export type ExpectedOccurrence = {
  recurringId: number;
  label: string;
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  categorySlug: string | null;
  expectedDate: Date; // dayOfMonth clamped to month length
  status: OccurrenceStatus;
  linkedTxId?: number; // set when status is 'linkeado' or 'synthetic'
  gapId?: number; // set when a recurring_gaps row exists for this slot
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Number of days after expectedDate after which we call a slot 'atrasado'. */
const ATRASADO_THRESHOLD_DAYS = 5;

export function daysInMonth(yearMonth: string): number {
  const [y, m] = yearMonth.split("-").map(Number);
  // Date.UTC(year, month, 0) = last day of previous month = last day of (month-1) = days in month
  // We pass m (1-based month) as the month argument and 0 as day — gives us last day of month m-1.
  // To get days in month m (1-based): UTC(y, m, 0).
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Clamp dayOfMonth to the actual month length. Handles Feb 28/29, months with 30 days, etc. */
export function clampDay(dayOfMonth: number, yearMonth: string): number {
  return Math.min(dayOfMonth, daysInMonth(yearMonth));
}

/** Build a Date (UTC midnight) for the expected occurrence in a given month. */
export function buildExpectedDate(dayOfMonth: number, yearMonth: string): Date {
  const [y, m] = yearMonth.split("-").map(Number);
  const day = clampDay(dayOfMonth, yearMonth);
  return new Date(Date.UTC(y, m - 1, day));
}

/** Return YYYY-MM for the month following the given yearMonth. Handles Dec→Jan rollover. */
export function nextYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  if (m === 12) {
    return `${y + 1}-01`;
  }
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

/**
 * Compute expected occurrences for every active recurring of the given user
 * for the specified yearMonth. Returns one entry per recurring — never more.
 *
 * Architecture invariant: this function READS. It never writes to transactions.
 * The caller (RSC page) merges the result with real tx rows for rendering.
 *
 * Tenant safety: ALL queries filter by userId explicitly.
 */
export async function getExpectedOccurrencesForMonth(
  userId: number,
  yearMonth: string,
  today: Date = new Date(),
  database: DB = defaultDb,
): Promise<ExpectedOccurrence[]> {
  log.info(
    { event: "expected_occurrences_query", userId, yearMonth },
    "querying expected occurrences",
  );

  // 1. Fetch all active recurrings for this user.
  const recurrings = await database
    .select({
      id: recurringTransactions.id,
      label: recurringTransactions.label,
      accountId: recurringTransactions.accountId,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      categorySlug: recurringTransactions.categorySlug,
      dayOfMonth: recurringTransactions.dayOfMonth,
      skippedMonths: recurringTransactions.skippedMonths,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

  if (recurrings.length === 0) return [];

  const recurringIds = recurrings.map((r) => r.id);

  // 2. Fetch existing tx links for this (user, yearMonth) batch.
  // Tenant safety: filter by userId AND recurringYearMonth.
  const linkedTxs = await database
    .select({
      id: transactions.id,
      recurringId: transactions.recurringId,
      source: transactions.source,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.recurringId, recurringIds),
        eq(transactions.recurringYearMonth, yearMonth),
        notDeleted(transactions.deletedAt),
      ),
    );

  // Map: recurringId → { txId, source }
  const linkedMap = new Map<number, { txId: number; source: string }>();
  for (const tx of linkedTxs) {
    if (tx.recurringId !== null) {
      linkedMap.set(tx.recurringId, { txId: tx.id, source: tx.source });
    }
  }

  // 3. Fetch recurring_gaps for this (user, yearMonth) batch.
  // Tenant safety: filter by userId.
  const gaps = await database
    .select({
      id: recurringGaps.id,
      recurringId: recurringGaps.recurringId,
      resolution: recurringGaps.resolution,
    })
    .from(recurringGaps)
    .where(
      and(
        eq(recurringGaps.userId, userId),
        inArray(recurringGaps.recurringId, recurringIds),
        eq(recurringGaps.yearMonth, yearMonth),
      ),
    );

  // Map: recurringId → { gapId, resolution }
  const gapMap = new Map<number, { gapId: number; resolution: string | null }>();
  for (const g of gaps) {
    gapMap.set(g.recurringId, { gapId: g.id, resolution: g.resolution });
  }

  // 4. Build today's UTC-midnight date for status threshold comparisons.
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const atrasadoMs = ATRASADO_THRESHOLD_DAYS * 86400000;

  // 5. Compute status for each recurring.
  const occurrences: ExpectedOccurrence[] = [];

  for (const r of recurrings) {
    const expectedDate = buildExpectedDate(r.dayOfMonth, yearMonth);

    // Linked tx?
    const linked = linkedMap.get(r.id);
    if (linked) {
      const status: OccurrenceStatus = linked.source === "recurring" ? "synthetic" : "linkeado";
      occurrences.push({
        recurringId: r.id,
        label: r.label,
        accountId: r.accountId,
        amountCents: r.amountCents,
        currency: r.currency as Currency,
        categorySlug: r.categorySlug,
        expectedDate,
        status,
        linkedTxId: linked.txId,
      });
      continue;
    }

    // Gap exists?
    const gapEntry = gapMap.get(r.id);
    if (gapEntry) {
      let status: OccurrenceStatus;
      if (gapEntry.resolution === "skipped") {
        status = "skipped";
      } else if (gapEntry.resolution === null) {
        // Open gap — atrasado if past the window.
        status = expectedDate.getTime() < todayUtc.getTime() - atrasadoMs ? "atrasado" : "esperado";
      } else {
        // Resolved some other way (auto-linked, linked) but tx not found above?
        // Treat as esperado so it still surfaces for inspection.
        status = "esperado";
      }
      occurrences.push({
        recurringId: r.id,
        label: r.label,
        accountId: r.accountId,
        amountCents: r.amountCents,
        currency: r.currency as Currency,
        categorySlug: r.categorySlug,
        expectedDate,
        status,
        gapId: gapEntry.gapId,
      });
      continue;
    }

    // No gap detected yet (cron hasn't run for this month, or it's the current month).
    // Derive status from today vs expectedDate. Only include if expected month <= current month.
    // We only show forecast rows for the current or past months (future months are out of scope).
    const [ym_y, ym_m] = yearMonth.split("-").map(Number);
    const expectedYmDate = new Date(Date.UTC(ym_y, ym_m - 1, 1)); // first of the month
    const currentYm = `${todayUtc.getUTCFullYear()}-${String(todayUtc.getUTCMonth() + 1).padStart(2, "0")}`;
    const [cy, cm] = currentYm.split("-").map(Number);
    const currentMonthStart = new Date(Date.UTC(cy, cm - 1, 1));

    // Only emit forecast if the month is current or past (not future months).
    if (expectedYmDate > currentMonthStart) continue;

    // If the month is in the past (closed month) and no gap was detected, skip.
    // The cron should have detected it; if it didn't, we don't fabricate gaps.
    if (expectedYmDate < currentMonthStart) continue;

    // Current month, no gap yet.
    // Check skipped_months on the recurring.
    if ((r.skippedMonths ?? []).includes(yearMonth)) continue;

    // Skip occurrences whose day hasn't arrived yet — only past/today days are "expected".
    // Future-day rows flood the transaction list on day 1 of the month (#695).
    // Note: this guard applies ONLY to the no-gap branch. If a linked tx or an existing
    // gap row already covers a future day (early bank posting, cron artefact), it passes
    // through the earlier branches above and is intentionally kept.
    if (expectedDate.getTime() > todayUtc.getTime()) continue;

    const status: OccurrenceStatus =
      expectedDate.getTime() < todayUtc.getTime() - atrasadoMs ? "atrasado" : "esperado";

    occurrences.push({
      recurringId: r.id,
      label: r.label,
      accountId: r.accountId,
      amountCents: r.amountCents,
      currency: r.currency as Currency,
      categorySlug: r.categorySlug,
      expectedDate,
      status,
    });
  }

  return occurrences;
}

/**
 * Count pending occurrences for the user — open gaps + current-month atrasado
 * not yet in a gap. Used by RecurringPendingBanner.
 *
 * Tenant safety: all queries filter by userId.
 */
export async function countPendingOccurrences(
  userId: number,
  today: Date = new Date(),
  database: DB = defaultDb,
): Promise<number> {
  // Count open recurring_gaps (resolution IS NULL) for this user.
  const openGaps = await database
    .select({ id: recurringGaps.id })
    .from(recurringGaps)
    .where(and(eq(recurringGaps.userId, userId), isNull(recurringGaps.resolution)));

  // Count current-month occurrences that are atrasado but not yet in a gap.
  const currentYm = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const currentMonthOccurrences = await getExpectedOccurrencesForMonth(
    userId,
    currentYm,
    today,
    database,
  );

  // Subtract those that already have a gapId (counted above in openGaps).
  const noGapAtrasado = currentMonthOccurrences.filter(
    (o) => (o.status === "atrasado" || o.status === "esperado") && o.gapId === undefined,
  ).length;

  return openGaps.length + noGapAtrasado;
}

// ---------------------------------------------------------------------------
// getForecastOccurrences — enriches occurrences with account display info.
// Lives here (NOT in a "use server" file) because it accepts userId as a
// parameter — exposing it as a Server Action would allow any client to read
// any user's forecast data by passing an arbitrary userId (#622 C1).
// Callers (RSC pages) derive userId from getSessionUser() before calling.
// ---------------------------------------------------------------------------

export type ForecastOccurrence = ExpectedOccurrence & {
  // Serialized-safe version: Date → string for RSC prop passing.
  expectedDateIso: string;
  accountName: string;
  accountCurrency: string;
};

/**
 * Enriches expected occurrences for a month with account display labels.
 * Tenant-safe: the inner getExpectedOccurrencesForMonth filters by userId,
 * and the accounts query also filters by userId.
 *
 * NOT a Server Action. Must stay in a regular (non-"use server") module.
 * Callers must derive userId from getSessionUser() — never accept it over the wire.
 */
export async function getForecastOccurrences(
  userId: number,
  yearMonth: string,
  today?: Date,
): Promise<ForecastOccurrence[]> {
  const occurrences = await getExpectedOccurrencesForMonth(userId, yearMonth, today);

  if (occurrences.length === 0) return [];

  const accountIds = [...new Set(occurrences.map((o) => o.accountId))];
  const accountRows = await defaultDb
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        inArray(accounts.id, accountIds),
        notDeleted(accounts.deletedAt),
      ),
    );

  const accountMap = new Map(accountRows.map((a) => [a.id, a]));

  return occurrences
    .filter((o) => accountMap.has(o.accountId))
    .map((o) => {
      const acc = accountMap.get(o.accountId)!;
      return {
        ...o,
        expectedDateIso: o.expectedDate.toISOString(),
        accountName: formatAccountLabel(acc),
        accountCurrency: acc.currency,
      };
    });
}
