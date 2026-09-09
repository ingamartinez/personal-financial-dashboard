import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  recurringGaps,
  recurringLinkObservations,
  recurringTransactions,
  recurringDescriptionPatterns,
  transactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emit } from "@/lib/events/bus";
import { recordRecurringLinkObservation } from "@/lib/recurring/observation-recorder";
import { scoreMatchCandidates, type MatchCandidate } from "@/lib/recurring/match-score";
import { claimSlotForTx, occurrenceWindow } from "@/lib/recurring/slot";
import { detectPriceHike } from "@/lib/recurring/price-hike-detector";
import { emitNotification } from "@/lib/notifications/emit";
import { formatMoney } from "@/lib/money";
import { createLogger } from "@/lib/logger";
import type { Currency } from "@/lib/types";

const log = createLogger({ module: "recurring/auto-link" });

// ---------------------------------------------------------------------------
// Price-hike detection helper (#701)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: fetch last 4 observations for the given recurring (scoped to
 * userId, skipping variable-type recurrings), run the detector, and emit a
 * notification on hike. Non-critical — errors are logged and swallowed.
 */
async function maybeEmitPriceHikeNotification(
  userId: number,
  recurringId: number,
  database: DB,
): Promise<void> {
  // Skip if the recurring is variable — variable recurrings fluctuate by design.
  const [rec] = await database
    .select({
      amountType: recurringTransactions.amountType,
      label: recurringTransactions.label,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.id, recurringId),
        eq(recurringTransactions.userId, userId),
        notDeleted(recurringTransactions.deletedAt),
      ),
    )
    .limit(1);

  if (!rec || rec.amountType === "variable") return;

  // Fetch last 4 observations for this recurring, most recent first.
  const recent = await database
    .select({
      realAmountCents: recurringLinkObservations.realAmountCents,
      observedAt: recurringLinkObservations.observedAt,
      realCurrency: recurringLinkObservations.realCurrency,
    })
    .from(recurringLinkObservations)
    .where(
      and(
        eq(recurringLinkObservations.userId, userId),
        eq(recurringLinkObservations.recurringId, recurringId),
      ),
    )
    .orderBy(desc(recurringLinkObservations.observedAt))
    .limit(4);

  const hike = detectPriceHike(recurringId, recent);
  if (!hike) return;

  const absOld = hike.oldAmountCents < BigInt(0) ? -hike.oldAmountCents : hike.oldAmountCents;
  const absNew = hike.newAmountCents < BigInt(0) ? -hike.newAmountCents : hike.newAmountCents;
  const currency = hike.currency;
  const oldFormatted = formatMoney(absOld, currency);
  const newFormatted = formatMoney(absNew, currency);
  const pctStr = Math.round(hike.deltaPct).toString();
  const sinceStr = hike.sinceDate.toLocaleDateString("es-CO", {
    month: "short",
    day: "numeric",
  });

  await emitNotification(userId, {
    type: "subscription_price_hike",
    entityId: `price-hike-${recurringId}-${absNew.toString()}`,
    title: `${rec.label} subió de ${oldFormatted} a ${newFormatted}`,
    body: `+${pctStr}% desde ${sinceStr}. Revisar /recurring`,
    actionUrl: "/recurring",
    priority: "medium",
    metadata: {
      recurringId,
      oldAmountCents: hike.oldAmountCents.toString(),
      newAmountCents: hike.newAmountCents.toString(),
      deltaPct: hike.deltaPct,
      sinceDate: hike.sinceDate.toISOString(),
    },
  });

  log.info(
    {
      event: "subscription_price_hike_emitted",
      userId,
      recurringId,
      oldAmountCents: hike.oldAmountCents.toString(),
      newAmountCents: hike.newAmountCents.toString(),
      deltaPct: hike.deltaPct,
    },
    "subscription price hike notification emitted",
  );
}

export type AutoLinkResult =
  | { status: "no-open-gap" }
  | { status: "already-linked" }
  | { status: "ambiguous"; candidateCount: number }
  | { status: "linked"; gapId: number | null; recurringId: number; yearMonth: string };

// ---------------------------------------------------------------------------
// Candidate resolution (#804) — shared by the gap path and the direct path.
//
// Two tiers, in order:
//   1. "Classic" — same account AND exact amount. This is the pre-#804 fast
//      path, kept as-is for backward compatibility: it is the strongest
//      possible signal and needs no learned description pattern to trust.
//      Exactly one classic candidate wins immediately. Two+ classic
//      candidates are a genuine, strong-signal collision (both look equally
//      right) — the description-fingerprint scorer is given a chance to
//      break the tie, but if it can't, this is real ambiguity (not "no
//      signal"), so it is reported as `ambiguous`, matching the pre-#804
//      behaviour for e.g. two recurrings sharing account + amount.
//   2. "Cross-account fallback" — used only when NO classic candidate
//      exists (different account, and/or the amount only matches via a
//      learned fingerprint). Delegates entirely to scoreMatchCandidates,
//      which blocks amount-only guessing whenever the description has an
//      extractable-but-unmatched token (the KFC/SmartFit false-positive
//      guard) — appropriate here because none of these candidates have the
//      strong classic signal to fall back on.
// ---------------------------------------------------------------------------

type Candidate = {
  recurringId: number;
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  yearMonth: string;
  gapId: number | null;
};

type ResolveResult =
  | { winner: Candidate; ambiguousCount: null }
  | { winner: null; ambiguousCount: number | null };

async function fetchPatternsFor(
  userId: number,
  recurringIds: number[],
  database: DB,
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (recurringIds.length === 0) return map;

  const rows = await database
    .select({
      recurringId: recurringDescriptionPatterns.recurringId,
      pattern: recurringDescriptionPatterns.pattern,
    })
    .from(recurringDescriptionPatterns)
    .where(
      and(
        eq(recurringDescriptionPatterns.userId, userId),
        inArray(recurringDescriptionPatterns.recurringId, recurringIds),
        // Require at least 2 observations before trusting a pattern — a
        // single manual link isn't enough signal yet. NOTE: patternAmbiguous
        // is intentionally NOT filtered here (#804) — ambiguity across
        // recurrings now means "requires a second signal", not "disabled".
        sql`${recurringDescriptionPatterns.observationCount} >= 2`,
      ),
    );

  for (const r of rows) {
    if (r.pattern === null) continue;
    const arr = map.get(r.recurringId) ?? [];
    arr.push(r.pattern);
    map.set(r.recurringId, arr);
  }
  return map;
}

async function resolveCandidate(
  userId: number,
  tx: { accountId: number; amountCents: bigint; currency: Currency; descriptionRaw: string | null },
  candidates: Candidate[],
  database: DB,
): Promise<ResolveResult> {
  if (candidates.length === 0) return { winner: null, ambiguousCount: null };

  const classic = candidates.filter(
    (c) =>
      c.accountId === tx.accountId &&
      c.currency === tx.currency &&
      c.amountCents === tx.amountCents,
  );

  if (classic.length === 1) return { winner: classic[0]!, ambiguousCount: null };

  const pool = classic.length >= 2 ? classic : candidates;
  const patternMap = await fetchPatternsFor(
    userId,
    pool.map((c) => c.recurringId),
    database,
  );
  const scoreCandidates: MatchCandidate[] = pool.map((c) => ({
    recurringId: c.recurringId,
    accountId: c.accountId,
    amountCents: c.amountCents,
    currency: c.currency,
    patterns: patternMap.get(c.recurringId) ?? [],
  }));
  const scored = scoreMatchCandidates(
    {
      descriptionRaw: tx.descriptionRaw,
      amountCents: tx.amountCents,
      currency: tx.currency,
      accountId: tx.accountId,
    },
    scoreCandidates,
  );

  if (scored.winner) {
    const winner = pool.find((c) => c.recurringId === scored.winner!.recurringId);
    if (winner) return { winner, ambiguousCount: null };
  }

  if (classic.length >= 2) {
    // Strong classic matches tied and the scorer couldn't break the tie —
    // genuine ambiguity, regardless of the scorer's blocked/ambiguous
    // distinction (both classic candidates already look equally plausible).
    return { winner: null, ambiguousCount: classic.length };
  }

  return { winner: null, ambiguousCount: scored.ambiguous ? pool.length : null };
}

/**
 * Called after a new transaction is inserted by any ingestion flow (SMS,
 * Apple Pay, OCR, CSV, manual). Two paths, gap-path first:
 *
 *   - Gap path: matches against open recurring_gaps rows (created by the
 *     monthly cron). The gap's yearMonth is authoritative.
 *   - Direct path: no gap exists yet (current month, before the cron runs).
 *     Matches directly against active recurring_transactions, computing the
 *     claimed occurrence via the slot-claiming rule (src/lib/recurring/slot.ts).
 *
 * #804: Neither path requires the transaction's account to match the
 * recurring's configured account anymore — see resolveCandidate() above.
 * Both paths respect skippedMonths (never auto-link an explicitly skipped
 * occurrence) and the one-tx-per-occurrence invariant (enforced here via a
 * pre-check, and at the DB level by the transactions_recurring_unique index).
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
      currency: transactions.currency,
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

  const txForResolve = {
    accountId: tx.accountId,
    amountCents: tx.amountCents,
    currency: tx.currency,
    descriptionRaw: tx.descriptionRaw,
  };

  // ── Gap path ──────────────────────────────────────────────────────────
  const openGapRows = await database
    .select({
      gapId: recurringGaps.id,
      gapYearMonth: recurringGaps.yearMonth,
      recurringId: recurringTransactions.id,
      recurringAccountId: recurringTransactions.accountId,
      recurringAmountCents: recurringTransactions.amountCents,
      recurringCurrency: recurringTransactions.currency,
      dayOfMonth: recurringTransactions.dayOfMonth,
      skippedMonths: recurringTransactions.skippedMonths,
    })
    .from(recurringGaps)
    .innerJoin(
      recurringTransactions,
      and(
        eq(recurringTransactions.id, recurringGaps.recurringId),
        // Tenant safety: pair user_id on both sides of the JOIN.
        eq(recurringTransactions.userId, recurringGaps.userId),
      ),
    )
    .where(and(eq(recurringGaps.userId, userId), eq(recurringTransactions.userId, userId)));

  const t = tx.occurredAt.getTime();
  const gapCandidates: Candidate[] = openGapRows
    .filter((g) => {
      const [y, m] = g.gapYearMonth.split("-").map(Number);
      const win = occurrenceWindow(y!, m!, g.dayOfMonth);
      const inWindow = t >= win.start.getTime() && t < win.endExclusive.getTime();
      const skipped = (g.skippedMonths ?? []).includes(g.gapYearMonth);
      return inWindow && !skipped;
    })
    .map((g) => ({
      recurringId: g.recurringId,
      accountId: g.recurringAccountId,
      amountCents: g.recurringAmountCents,
      currency: g.recurringCurrency,
      yearMonth: g.gapYearMonth,
      gapId: g.gapId,
    }));

  const gapResolution = await resolveCandidate(userId, txForResolve, gapCandidates, database);

  if (gapResolution.ambiguousCount !== null) {
    return { status: "ambiguous", candidateCount: gapResolution.ambiguousCount };
  }

  if (gapResolution.winner) {
    const hit = gapResolution.winner;

    const result = await database.transaction(async (trx) => {
      await trx
        .update(transactions)
        .set({
          recurringId: hit.recurringId,
          recurringYearMonth: hit.yearMonth,
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
        .where(and(eq(recurringGaps.userId, userId), eq(recurringGaps.id, hit.gapId!)));

      return {
        status: "linked" as const,
        gapId: hit.gapId,
        recurringId: hit.recurringId,
        yearMonth: hit.yearMonth,
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
    )
      .then(() => {
        // #701: After observation is recorded, check for price hike (fire-and-forget).
        maybeEmitPriceHikeNotification(userId, result.recurringId, database).catch(
          (err: unknown) => {
            log.error(
              { err, event: "price_hike_emit_failed", recurringId: result.recurringId, userId },
              "failed to emit subscription price hike notification (gap path) — non-critical",
            );
          },
        );
      })
      .catch((err) => {
        log.error(
          {
            err,
            event: "observation_record_failed",
            txId,
            recurringId: result.recurringId,
            userId,
          },
          "failed to record recurring link observation (gap path) — non-critical",
        );
      });

    return result;
  }

  // ── Direct path (no gap exists yet — current month) ──────────────────
  const activeRecurrings = await database
    .select({
      recurringId: recurringTransactions.id,
      accountId: recurringTransactions.accountId,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
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

  const claimed = activeRecurrings
    .map((r) => {
      const slot = claimSlotForTx(tx.occurredAt, r.dayOfMonth);
      return { ...r, yearMonth: slot.ym };
    })
    // Explicit skip is the only thing that voids an occurrence.
    .filter((r) => !(r.skippedMonths ?? []).includes(r.yearMonth));

  let directCandidates: Candidate[] = claimed.map((r) => ({
    recurringId: r.recurringId,
    accountId: r.accountId,
    amountCents: r.amountCents,
    currency: r.currency,
    yearMonth: r.yearMonth,
    gapId: null,
  }));

  if (directCandidates.length > 0) {
    // Never re-claim an occurrence that already has an explicit link.
    const recurringIds = [...new Set(directCandidates.map((c) => c.recurringId))];
    const yearMonths = [...new Set(directCandidates.map((c) => c.yearMonth))];
    const takenRows = await database
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.recurringId, recurringIds),
          inArray(transactions.recurringYearMonth, yearMonths),
          notDeleted(transactions.deletedAt),
        ),
      );
    const taken = new Set(
      takenRows
        .filter((r) => r.recurringId !== null && r.recurringYearMonth !== null)
        .map((r) => `${r.recurringId}:${r.recurringYearMonth}`),
    );
    directCandidates = directCandidates.filter(
      (c) => !taken.has(`${c.recurringId}:${c.yearMonth}`),
    );
  }

  const directResolution = await resolveCandidate(userId, txForResolve, directCandidates, database);

  if (directResolution.ambiguousCount !== null) {
    return { status: "ambiguous", candidateCount: directResolution.ambiguousCount };
  }

  if (!directResolution.winner) return { status: "no-open-gap" };

  const directHit = directResolution.winner;

  try {
    await database.transaction(async (trx) => {
      await trx
        .update(transactions)
        .set({
          recurringId: directHit.recurringId,
          recurringYearMonth: directHit.yearMonth,
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
    // another tx already claimed this (recurringId, yearMonth) slot in a
    // race. Match the constraint name precisely — "Failed query" alone is
    // too broad (matches connection errors, FK violations, etc.).
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    if (
      msg.includes("transactions_recurring_unique") ||
      causeMsg.includes("transactions_recurring_unique")
    ) {
      log.info(
        {
          txId,
          recurringId: directHit.recurringId,
          yearMonth: directHit.yearMonth,
          userId,
        },
        "direct auto-link: slot already taken — skipping",
      );
      return { status: "no-open-gap" };
    }
    throw err;
  }

  log.info(
    {
      event: "auto_link_direct",
      txId,
      recurringId: directHit.recurringId,
      yearMonth: directHit.yearMonth,
      userId,
    },
    "auto-linked tx directly to active recurring",
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
    {
      userId,
      recurringId: directHit.recurringId,
      txId,
      yearMonth: directHit.yearMonth,
      manual: false,
    },
    database,
  )
    .then(() => {
      // #701: After observation is recorded, check for price hike (fire-and-forget).
      maybeEmitPriceHikeNotification(userId, directHit.recurringId, database).catch(
        (err: unknown) => {
          log.error(
            { err, event: "price_hike_emit_failed", recurringId: directHit.recurringId, userId },
            "failed to emit subscription price hike notification (direct path) — non-critical",
          );
        },
      );
    })
    .catch((err) => {
      log.error(
        {
          err,
          event: "observation_record_failed",
          txId,
          recurringId: directHit.recurringId,
          userId,
        },
        "failed to record recurring link observation (direct path) — non-critical",
      );
    });

  return {
    status: "linked",
    gapId: null,
    recurringId: directHit.recurringId,
    yearMonth: directHit.yearMonth,
  };
}
