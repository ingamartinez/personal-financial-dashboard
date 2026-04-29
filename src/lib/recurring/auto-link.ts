import { and, eq, isNull, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  recurringGaps,
  recurringTransactions,
  recurringDescriptionPatterns,
  transactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emit } from "@/lib/events/bus";
import {
  DEFAULT_WINDOW_AFTER_DAYS,
  DEFAULT_WINDOW_BEFORE_DAYS,
} from "@/lib/recurring/gap-detector";
import {
  recordRecurringLinkObservation,
  tokeniseDescription,
} from "@/lib/recurring/observation-recorder";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "recurring/auto-link" });

export type AutoLinkResult =
  | { status: "no-open-gap" }
  | { status: "already-linked" }
  | { status: "ambiguous"; candidateCount: number }
  | { status: "linked"; gapId: number | null; recurringId: number; yearMonth: string };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Derive the YYYY-MM string from a Date.
 * Uses UTC to match how we store occurredAt.
 */
function toYearMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Called after a new transaction is inserted by any ingestion flow (SMS,
 * Apple Pay, OCR, CSV, manual). Looks for an unresolved gap whose recurring
 * matches the tx by account + amount + expected window.
 *
 * Fall-through (direct-recurring) path:
 *   When no gap matches — which is the normal situation in the CURRENT month
 *   before the cron has run and created any gap rows — we look directly at
 *   active, non-deleted recurring_transactions and apply the same window/sign
 *   rules. This unblocks auto-linking for the entire current month.
 *
 * Rules (both paths):
 *   - If tx already has a recurring_id, skip (another flow linked it).
 *   - If exactly ONE candidate matches, link the tx.
 *   - If multiple candidates match, do nothing — let the user resolve from the
 *     inbox (ambiguity is rare; same amount from same account in same window).
 *   - If no candidate matches, return no-open-gap.
 *
 * Idempotency (direct path):
 *   The unique partial index `transactions_recurring_unique` on
 *   (recurring_id, recurring_year_month) WHERE recurring_id IS NOT NULL
 *   prevents two transactions from claiming the same slot. If a slot is already
 *   taken we treat it as no-open-gap (not an error).
 */
export async function autoLinkTransaction(
  userId: number,
  txId: number,
  database: DB = defaultDb,
): Promise<AutoLinkResult> {
  const [tx] = await database
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      recurringId: transactions.recurringId,
      descriptionRaw: transactions.descriptionRaw,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, txId),
        notDeleted(transactions.deletedAt),
      ),
    )
    .limit(1);

  if (!tx) return { status: "no-open-gap" };
  if (tx.recurringId) return { status: "already-linked" };

  // ── Gap path (existing logic, unchanged) ─────────────────────────────────
  const candidates = await database
    .select({
      gapId: recurringGaps.id,
      gapYearMonth: recurringGaps.yearMonth,
      recurringId: recurringTransactions.id,
      recurringAccountId: recurringTransactions.accountId,
      recurringAmountCents: recurringTransactions.amountCents,
      dayOfMonth: recurringTransactions.dayOfMonth,
    })
    .from(recurringGaps)
    .innerJoin(recurringTransactions, eq(recurringTransactions.id, recurringGaps.recurringId))
    .where(
      and(
        eq(recurringGaps.userId, userId),
        // Defense-in-depth tenant pairing on the JOINed per-user table.
        // The gap.userId is already filtered, but pairing recurringTransactions.userId
        // matches the documented per-user-table-join-tenant-safety convention.
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.accountId, tx.accountId),
        eq(recurringTransactions.amountCents, tx.amountCents),
      ),
    );

  const matchingGaps = candidates.filter((c) => {
    const [y, m] = c.gapYearMonth.split("-").map(Number);
    const effectiveDay = Math.min(c.dayOfMonth, daysInMonth(y, m));
    const expected = new Date(Date.UTC(y, m - 1, effectiveDay));
    const windowStart = new Date(expected.getTime() - DEFAULT_WINDOW_BEFORE_DAYS * 86400000);
    const windowEnd = new Date(
      expected.getTime() + DEFAULT_WINDOW_AFTER_DAYS * 86400000 + 86399999,
    );
    const t = tx.occurredAt.getTime();
    return t >= windowStart.getTime() && t <= windowEnd.getTime();
  });

  if (matchingGaps.length > 1) return { status: "ambiguous", candidateCount: matchingGaps.length };

  if (matchingGaps.length === 1) {
    const hit = matchingGaps[0];

    const result = await database.transaction(async (trx) => {
      await trx
        .update(transactions)
        .set({
          recurringId: hit.recurringId,
          recurringYearMonth: hit.gapYearMonth,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, txId),
            isNull(transactions.recurringId),
          ),
        );

      await trx
        .delete(recurringGaps)
        .where(and(eq(recurringGaps.userId, userId), eq(recurringGaps.id, hit.gapId)));

      return {
        status: "linked" as const,
        gapId: hit.gapId,
        recurringId: hit.recurringId,
        yearMonth: hit.gapYearMonth,
      };
    });

    emit({
      type: "recurring-gap:resolved",
      userId,
      gapId: result.gapId,
      reason: "auto-linked",
      timestamp: Date.now(),
    });

    // #633: Record observation (auto, gap path).
    recordRecurringLinkObservation(
      { userId, recurringId: result.recurringId, txId, yearMonth: result.yearMonth, manual: false },
      database,
    ).catch((err) => {
      log.error(
        { err, event: "observation_record_failed", txId, recurringId: result.recurringId, userId },
        "failed to record recurring link observation (gap path) — non-critical",
      );
    });

    return result;
  }

  // ── Direct-recurring path (no gap exists yet — current month) ────────────
  // Fetch active, non-deleted recurrings for this user+account+amount.
  // Window filtering is done in JS (same constants as gap path).
  // Cross-month extension (#632): for each candidate we evaluate expectedDate
  // for [txYearMonth-1, txYearMonth, txYearMonth+1] so a tx paid early for
  // next month (e.g. April 29 for May 1 recurring) is matched correctly.
  const directCandidates = await database
    .select({
      recurringId: recurringTransactions.id,
      dayOfMonth: recurringTransactions.dayOfMonth,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.accountId, tx.accountId),
        eq(recurringTransactions.amountCents, tx.amountCents),
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

  const txYearMonth = toYearMonth(tx.occurredAt);
  const [txYear, txMonth] = txYearMonth.split("-").map(Number);

  /**
   * Evaluate expectedDate for a given yearMonth (year, month 1-based).
   * Returns whether the tx falls in the match window for that month.
   */
  function txInWindowForYearMonth(dayOfMonth: number, year: number, month: number): boolean {
    const effectiveDay = Math.min(dayOfMonth, daysInMonth(year, month));
    const expected = new Date(Date.UTC(year, month - 1, effectiveDay));
    const windowStart = new Date(expected.getTime() - DEFAULT_WINDOW_BEFORE_DAYS * 86400000);
    const windowEnd = new Date(
      expected.getTime() + DEFAULT_WINDOW_AFTER_DAYS * 86400000 + 86399999,
    );
    const t = tx.occurredAt.getTime();
    return t >= windowStart.getTime() && t <= windowEnd.getTime();
  }

  /** Derive year/month for prev month (handles Jan → Dec rollover). */
  function prevYM(y: number, m: number): [number, number] {
    return m === 1 ? [y - 1, 12] : [y, m - 1];
  }

  /** Derive year/month for next month (handles Dec → Jan rollover). */
  function nextYM(y: number, m: number): [number, number] {
    return m === 12 ? [y + 1, 1] : [y, m + 1];
  }

  type DirectMatch = { recurringId: number; matchedYearMonth: string };

  const matchingDirect: DirectMatch[] = [];

  for (const c of directCandidates) {
    const [prevYear, prevMonth] = prevYM(txYear, txMonth);
    const [nextYear, nextMonth] = nextYM(txYear, txMonth);

    const evaluations: Array<{ year: number; month: number }> = [
      { year: prevYear, month: prevMonth },
      { year: txYear, month: txMonth },
      { year: nextYear, month: nextMonth },
    ];

    for (const { year, month } of evaluations) {
      if (txInWindowForYearMonth(c.dayOfMonth, year, month)) {
        const ym = `${year}-${String(month).padStart(2, "0")}`;
        matchingDirect.push({ recurringId: c.recurringId, matchedYearMonth: ym });
        // Only count one yearMonth per recurring (first match wins, sorted prev→curr→next).
        break;
      }
    }
  }

  // ── Description fingerprint fallback (#633) ──────────────────────────────
  // When the amount-based direct path finds no match, attempt a description
  // fingerprint lookup. Uses patterns with observation_count >= 2 that are not
  // marked ambiguous (Google Play caveat). Only active, non-deleted recurrings.
  //
  // Ambiguity rule preserved: if multiple recurrings match via description,
  // no auto-link (user resolves). Amount-only path still works independently.

  let descriptionFallbackCandidates: DirectMatch[] = [];

  if (matchingDirect.length === 0) {
    const descToken = tokeniseDescription(tx.descriptionRaw);
    if (descToken) {
      // Fetch unambiguous patterns for this user + token with enough signal.
      const matchingPatterns = await database
        .select({
          recurringId: recurringDescriptionPatterns.recurringId,
          dayOfMonth: recurringTransactions.dayOfMonth,
        })
        .from(recurringDescriptionPatterns)
        .innerJoin(
          recurringTransactions,
          and(
            eq(recurringTransactions.id, recurringDescriptionPatterns.recurringId),
            // Tenant-safety: pair user_id on both sides of the JOIN.
            eq(recurringTransactions.userId, recurringDescriptionPatterns.userId),
          ),
        )
        .where(
          and(
            eq(recurringDescriptionPatterns.userId, userId),
            eq(recurringDescriptionPatterns.pattern, descToken),
            eq(recurringDescriptionPatterns.patternAmbiguous, false),
            // Require at least 2 observations before trusting the pattern.
            sql`${recurringDescriptionPatterns.observationCount} >= 2`,
            eq(recurringTransactions.active, true),
            notDeleted(recurringTransactions.deletedAt),
          ),
        );

      for (const c of matchingPatterns) {
        const [prevYear, prevMonth] = prevYM(txYear, txMonth);
        const [nextYear, nextMonth] = nextYM(txYear, txMonth);

        const evaluations: Array<{ year: number; month: number }> = [
          { year: prevYear, month: prevMonth },
          { year: txYear, month: txMonth },
          { year: nextYear, month: nextMonth },
        ];

        for (const { year, month } of evaluations) {
          if (txInWindowForYearMonth(c.dayOfMonth, year, month)) {
            const ym = `${year}-${String(month).padStart(2, "0")}`;
            descriptionFallbackCandidates.push({
              recurringId: c.recurringId,
              matchedYearMonth: ym,
            });
            break;
          }
        }
      }

      // Deduplicate by recurringId (a pattern might match multiple windows for
      // the same recurring — take the first).
      const seen = new Set<number>();
      descriptionFallbackCandidates = descriptionFallbackCandidates.filter((c) => {
        if (seen.has(c.recurringId)) return false;
        seen.add(c.recurringId);
        return true;
      });

      if (descriptionFallbackCandidates.length > 1) {
        log.info(
          {
            event: "auto_link_description_ambiguous",
            txId,
            descToken,
            candidateCount: descriptionFallbackCandidates.length,
            userId,
          },
          "description fingerprint ambiguous — multiple recurrings match",
        );
        return { status: "ambiguous", candidateCount: descriptionFallbackCandidates.length };
      }
    }
  }

  // Resolve final candidate: amount-based match takes priority; description fallback is secondary.
  const allCandidates = matchingDirect.length > 0 ? matchingDirect : descriptionFallbackCandidates;

  if (allCandidates.length === 0) return { status: "no-open-gap" };
  if (allCandidates.length > 1)
    return { status: "ambiguous", candidateCount: allCandidates.length };

  const directHit = allCandidates[0];
  // Use the yearMonth derived from the window match (may be prev/next month).
  const directYearMonth = directHit.matchedYearMonth;

  try {
    await database.transaction(async (trx) => {
      await trx
        .update(transactions)
        .set({
          recurringId: directHit.recurringId,
          recurringYearMonth: directYearMonth,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, txId),
            isNull(transactions.recurringId),
          ),
        );
    });
  } catch (err: unknown) {
    // The unique partial index transactions_recurring_unique will throw if
    // another tx already claimed this (recurringId, yearMonth) slot.
    // Match the constraint name precisely — "Failed query" alone is too broad
    // (it matches connection errors, FK violations, etc.) and would silently
    // swallow real failures. Drizzle wraps the pg error with "Failed query …"
    // and exposes the underlying PostgresError on err.cause, which carries the
    // constraint_name. Check both surfaces so the precise match is reliable.
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    if (
      msg.includes("transactions_recurring_unique") ||
      causeMsg.includes("transactions_recurring_unique")
    ) {
      log.info(
        { txId, recurringId: directHit.recurringId, yearMonth: directYearMonth, userId },
        "direct auto-link: slot already taken — skipping",
      );
      return { status: "no-open-gap" };
    }
    throw err;
  }

  const usedDescriptionFallback =
    matchingDirect.length === 0 && descriptionFallbackCandidates.length === 1;

  log.info(
    {
      event: "auto_link_direct",
      txId,
      recurringId: directHit.recurringId,
      yearMonth: directYearMonth,
      usedDescriptionFallback,
      userId,
    },
    "auto-linked tx directly to active recurring (no gap)",
  );

  emit({
    type: "recurring-gap:resolved",
    userId,
    gapId: null,
    reason: "auto-linked",
    timestamp: Date.now(),
  });

  // #633: Record observation (auto, direct path).
  recordRecurringLinkObservation(
    { userId, recurringId: directHit.recurringId, txId, yearMonth: directYearMonth, manual: false },
    database,
  ).catch((err) => {
    log.error(
      { err, event: "observation_record_failed", txId, recurringId: directHit.recurringId, userId },
      "failed to record recurring link observation (direct path) — non-critical",
    );
  });

  return {
    status: "linked",
    gapId: null,
    recurringId: directHit.recurringId,
    yearMonth: directYearMonth,
  };
}
