import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  recurringGaps,
  recurringLinkObservations,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emit } from "@/lib/events/bus";
import {
  recordRecurringLinkObservation,
  isGenericDescriptionToken,
  tokeniseDescription,
} from "@/lib/recurring/observation-recorder";
import { scoreMatchCandidates, type MatchCandidate } from "@/lib/recurring/match-score";
import {
  fetchAmountConsistentTokens,
  fetchPatterns,
  patternSetsEqual,
} from "@/lib/recurring/patterns";
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
// "Classic" candidates share the tx's account AND exact amount — the
// pre-#804 signal. It is a STRONG SCORING INPUT, never a bypass around the
// scorer (#804 CRITICAL fix — a KFC purchase byte-identical to Apple TV's
// amount, landing on Apple TV's own account, must still be blocked by the
// token guard). A lone classic candidate is trusted WITHOUT running the
// scorer only when doing so is provably safe:
//   - its amount does not also collide with any other candidate in the pool
//     (no competing recurring shares the exact amount), AND
//   - the tx's description has no extractable token, OR that candidate has
//     no learned patterns yet (nothing to contradict — first-ever payment
//     bootstrap), OR the token matches the candidate's own learned patterns.
// Any other case — including a lone classic candidate whose amount collides,
// or whose own learned patterns contradict the tx's token — falls through to
// the full description-fingerprint + amount scorer over the WHOLE candidate
// pool (cross-account matches included), which itself blocks amount-only
// guessing whenever the description has an extractable-but-unmatched token.
// Two+ classic candidates: the scorer gets a chance to break the tie. If it
// can't AND every tied candidate has an identical learned pattern set
// (empty-on-all counts as identical — #804 cold-start), pick the lowest
// recurringId. That pairing is CONVENTIONAL, not an identity claim: the
// leftover sibling is claimed by the next charge via the existing `taken`
// filter. Distinct pattern sets that still tie stay `ambiguous` — the tx
// matched none of them.
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
  { winner: Candidate; ambiguousCount: null } | { winner: null; ambiguousCount: number | null };

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

  if (classic.length === 1) {
    const lone = classic[0]!;
    const amountCollides = candidates.some(
      (c) =>
        c.recurringId !== lone.recurringId &&
        c.currency === tx.currency &&
        c.amountCents === tx.amountCents,
    );
    if (!amountCollides) {
      const token = tokeniseDescription(tx.descriptionRaw);
      if (token === null) {
        return { winner: lone, ambiguousCount: null };
      }
      const ownPatterns = (await fetchPatterns(userId, [lone.recurringId], database)).get(
        lone.recurringId,
      );
      // #804 ACCEPTED TRADE-OFF (deliberate, not a bug): a recurring with
      // zero learned patterns yet trusts ANY token on this classic path —
      // "nothing learned" reads as "nothing to contradict", not "reject".
      // This means a brand-new recurring's first ~2 occurrences (until
      // recordRecurringLinkObservation accumulates observationCount >= 2)
      // will auto-link on account+amount alone, even with an unrelated
      // merchant description, AS LONG AS the amount doesn't also collide
      // with another active recurring (amountCollides above still blocks
      // that). This is intentionally bounded and reversible: same account +
      // exact amount + in-window is the strongest pre-#804 signal, the
      // product decision was to be aggressive, and the one-tap "Deshacer
      // match" undo (recurring-list.tsx / recurring-calendar-grid.tsx)
      // exists precisely to make a wrong guess cheap. Do NOT "fix" this by
      // requiring a learned pattern here — that would block every brand-new
      // recurring's bootstrap entirely (see engram: architecture/804-*).
      if (
        !ownPatterns ||
        ownPatterns.length === 0 ||
        (ownPatterns.includes(token) &&
          (!isGenericDescriptionToken(token) || lone.amountCents === tx.amountCents))
      ) {
        return { winner: lone, ambiguousCount: null };
      }
      // Extractable token contradicts this candidate's own learned
      // patterns — do not trust the classic shortcut. Fall through to the
      // full scorer pool below.
    }
    // Amount also collides with another candidate — fall through too.
  }

  const pool = classic.length >= 2 ? classic : candidates;

  // #873: proven-sibling path. Classic is same-account only, so a recurring
  // paid from a different card never reaches the #804 cold-start bootstrap.
  // Cross-account matching used to wait for a trusted fingerprint
  // (observation_count >= 2), but one manual link only raises the count to 1
  // — a catch-22. Use the source observation itself, filtered to this
  // amount+currency, so a count-1 COLMEDICA hanging off a wrong-amount
  // mis-link stays inert. Do NOT lower fetchPatterns to >= 1.
  const siblingToken = tokeniseDescription(tx.descriptionRaw);
  if (siblingToken !== null) {
    const exactAmount = pool.filter(
      (c) => c.currency === tx.currency && c.amountCents === tx.amountCents,
    );
    if (
      exactAmount.length > 0 &&
      !(isGenericDescriptionToken(siblingToken) && exactAmount.length > 1)
    ) {
      const siblingMap = await fetchAmountConsistentTokens(
        userId,
        exactAmount.map((c) => c.recurringId),
        tx.amountCents,
        tx.currency,
        database,
      );
      const hits = exactAmount.filter((c) =>
        (siblingMap.get(c.recurringId) ?? []).includes(siblingToken),
      );
      if (hits.length === 1) {
        return { winner: hits[0]!, ambiguousCount: null };
      }
    }
  }

  const patternMap = await fetchPatterns(
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
    // Strong classic matches tied and the scorer couldn't break the tie.
    // If the tied recurrings are genuinely indistinguishable (identical
    // learned pattern sets, empty-on-all included), pick the lowest
    // recurringId — conventional pairing, not identity. The next charge
    // inherits the leftover via the `taken` filter. Distinct pattern sets
    // that still tied mean NONE matched the description: stay ambiguous.
    const sets = classic.map((c) => new Set(patternMap.get(c.recurringId) ?? []));
    const allIdentical = sets.every((s) => patternSetsEqual(s, sets[0]!));
    if (allIdentical) {
      const winner = classic.reduce((min, c) => (c.recurringId < min.recurringId ? c : min));
      return { winner, ambiguousCount: null };
    }
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
function isRecurringSlotTakenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return (
    msg.includes("transactions_recurring_unique") ||
    causeMsg.includes("transactions_recurring_unique")
  );
}

export async function autoLinkTransaction(
  userId: number,
  txId: number,
  database: DB = defaultDb,
): Promise<AutoLinkResult> {
  return autoLinkTransactionOnce(userId, txId, database, true);
}

async function autoLinkTransactionOnce(
  userId: number,
  txId: number,
  database: DB,
  retryOnSlotTaken: boolean,
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
    .where(
      and(
        eq(recurringGaps.userId, userId),
        eq(recurringTransactions.userId, userId),
        // Manual link closes gaps by setting resolution; auto-link deletes.
        // Either way, a resolved row must not be a candidate.
        isNull(recurringGaps.resolution),
        // #883: archiving/deactivating does not close open gaps. Filter at
        // read time (same as #876 fingerprints) so leftover rows cannot win
        // as the unique candidate. gap-detector already refuses to create
        // new gaps for dead recurrings.
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

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

    let result: {
      status: "linked";
      gapId: number | null;
      recurringId: number;
      yearMonth: string;
    };
    try {
      const committed = await database.transaction(async (trx) => {
        const updated = await trx
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
          )
          .returning({ id: transactions.id });
        if (updated.length === 0) return null;

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
      if (!committed) return { status: "already-linked" };
      result = committed;
    } catch (err: unknown) {
      if (isRecurringSlotTakenError(err)) {
        if (retryOnSlotTaken) {
          log.info(
            {
              event: "auto_link_slot_retry",
              path: "gap",
              txId,
              recurringId: hit.recurringId,
              yearMonth: hit.yearMonth,
              userId,
            },
            "gap auto-link: slot taken — retrying once against remaining candidates",
          );
          return autoLinkTransactionOnce(userId, txId, database, false);
        }
        log.info(
          {
            txId,
            recurringId: hit.recurringId,
            yearMonth: hit.yearMonth,
            userId,
          },
          "gap auto-link: slot already taken — skipping",
        );
        return { status: "no-open-gap" };
      }
      throw err;
    }

    emit({
      type: "recurring-gap:resolved",
      userId,
      gapId: result.gapId,
      reason: "auto-linked",
      timestamp: Date.now(),
    });

    // #633: Record observation (auto, gap path). Awaited so callers that
    // re-derive pattern counts after a batch of links (rebuild) see the
    // increment. Failures stay non-critical. Price-hike stays fire-and-forget.
    try {
      await recordRecurringLinkObservation(
        {
          userId,
          recurringId: result.recurringId,
          txId,
          yearMonth: result.yearMonth,
          manual: false,
        },
        database,
      );
      maybeEmitPriceHikeNotification(userId, result.recurringId, database).catch((err: unknown) => {
        log.error(
          { err, event: "price_hike_emit_failed", recurringId: result.recurringId, userId },
          "failed to emit subscription price hike notification (gap path) — non-critical",
        );
      });
    } catch (err) {
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
    }

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
    const updated = await database.transaction(async (trx) => {
      return trx
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
        )
        .returning({ id: transactions.id });
    });
    if (updated.length === 0) return { status: "already-linked" };
  } catch (err: unknown) {
    // The unique partial index transactions_recurring_unique will throw if
    // another tx already claimed this (recurringId, yearMonth) slot in a
    // race. Match the constraint name precisely — "Failed query" alone is
    // too broad (matches connection errors, FK violations, etc.).
    if (isRecurringSlotTakenError(err)) {
      if (retryOnSlotTaken) {
        log.info(
          {
            event: "auto_link_slot_retry",
            path: "direct",
            txId,
            recurringId: directHit.recurringId,
            yearMonth: directHit.yearMonth,
            userId,
          },
          "direct auto-link: slot taken — retrying once against remaining candidates",
        );
        return autoLinkTransactionOnce(userId, txId, database, false);
      }
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

  // #633: Record observation (auto, direct path). Awaited so callers that
  // re-derive pattern counts after a batch of links (rebuild) see the
  // increment. Failures stay non-critical. Price-hike stays fire-and-forget.
  try {
    await recordRecurringLinkObservation(
      {
        userId,
        recurringId: directHit.recurringId,
        txId,
        yearMonth: directHit.yearMonth,
        manual: false,
      },
      database,
    );
    maybeEmitPriceHikeNotification(userId, directHit.recurringId, database).catch(
      (err: unknown) => {
        log.error(
          { err, event: "price_hike_emit_failed", recurringId: directHit.recurringId, userId },
          "failed to emit subscription price hike notification (direct path) — non-critical",
        );
      },
    );
  } catch (err) {
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
  }

  return {
    status: "linked",
    gapId: null,
    recurringId: directHit.recurringId,
    yearMonth: directHit.yearMonth,
  };
}
