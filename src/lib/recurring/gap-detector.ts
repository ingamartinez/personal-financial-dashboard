import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { recurringGaps, recurringTransactions, transactions, users } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { emitNotification } from "@/lib/notifications/emit";
import {
  isWithinAmountTolerance,
  pickTxForRecurring,
  type TxCandidate,
} from "@/lib/recurring/match-score";
import { tokeniseDescription } from "@/lib/recurring/observation-recorder";
import { fetchPatterns, fetchPatternsForOne, patternSetsEqual } from "@/lib/recurring/patterns";
import { occurrenceWindow } from "@/lib/recurring/slot";
import type { Currency } from "@/lib/types";

const log = createLogger({ module: "recurring/gap-detector" });

export type DetectResult = {
  yearMonth: string;
  checkedRecurrings: number;
  existingLinks: number;
  autoLinked: number;
  skippedIntentionally: number;
  gapsCreated: number;
  gapsAlreadyOpen: number;
};

function parseYearMonth(ym: string): { year: number; month: number } {
  const [year, month] = ym.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`invalid yearMonth: ${ym}`);
  }
  return { year, month };
}

/**
 * Drop a still-open gap row for (recurring, yearMonth). No-op when the row
 * is already gone or already resolved. Auto-link.ts deletes on success
 * rather than setting resolution='auto-linked' — match that convention so
 * the unique (recurring_id, year_month) slot is free if the occurrence is
 * later unlinked and the detector runs again.
 */
async function deleteOpenGap(
  userId: number,
  recurringId: number,
  yearMonth: string,
  database: DB,
): Promise<void> {
  await database
    .delete(recurringGaps)
    .where(
      and(
        eq(recurringGaps.userId, userId),
        eq(recurringGaps.recurringId, recurringId),
        eq(recurringGaps.yearMonth, yearMonth),
        isNull(recurringGaps.resolution),
      ),
    );
}

export function previousYearMonth(today: Date): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

type CandidateTxRow = {
  id: number;
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  descriptionRaw: string | null;
};

/**
 * Resolve which (if any) of the unlinked candidate transactions is this
 * recurring's payment for the occurrence.
 *
 * "Classic" (same account + exact amount) is a STRONG SCORING INPUT, never a
 * bypass around the token guard (#804 CRITICAL fix — a lone classic
 * candidate whose own extractable token contradicts this recurring's
 * learned patterns must not be trusted blindly; e.g. a KFC purchase
 * byte-identical to Apple TV's amount, landing on Apple TV's own account).
 * A lone classic candidate is trusted directly only when its description has
 * no extractable token, OR this recurring has no learned patterns yet
 * (nothing to contradict — first-ever payment bootstrap), OR the token
 * matches a learned pattern. Otherwise it falls through to the full
 * description-fingerprint + amount scorer (pickTxForRecurring) over ALL
 * candidates, matching auto-link.ts's resolveCandidate().
 */
async function resolveTxWinner(
  userId: number,
  recurring: { id: number; accountId: number; amountCents: bigint; currency: Currency },
  candidates: CandidateTxRow[],
  database: DB,
): Promise<CandidateTxRow | null> {
  if (candidates.length === 0) return null;

  const classic = candidates.filter(
    (c) =>
      c.accountId === recurring.accountId &&
      c.currency === recurring.currency &&
      c.amountCents === recurring.amountCents,
  );

  if (classic.length === 1) {
    const lone = classic[0]!;
    const token = tokeniseDescription(lone.descriptionRaw);
    if (token === null) return lone;
    const ownPatterns = await fetchPatternsForOne(userId, recurring.id, database);
    if (ownPatterns.length === 0 || ownPatterns.includes(token)) {
      return lone;
    }
    // Extractable token contradicts this recurring's own learned patterns —
    // do not trust the classic shortcut. Fall through to the pool below.
  }

  const pool = classic.length >= 2 ? classic : candidates;
  const patterns = await fetchPatternsForOne(userId, recurring.id, database);
  const txCandidates: TxCandidate[] = pool.map((c) => ({
    txId: c.id,
    accountId: c.accountId,
    amountCents: c.amountCents,
    currency: c.currency,
    descriptionRaw: c.descriptionRaw,
  }));
  const picked = pickTxForRecurring(
    {
      accountId: recurring.accountId,
      amountCents: recurring.amountCents,
      currency: recurring.currency,
      patterns,
    },
    txCandidates,
  );
  if (picked.winner) {
    return pool.find((c) => c.id === picked.winner!.txId) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bijective assignment for genuinely indistinguishable recurrings (#804 new
// requirement). When N recurrings share the exact same (account, currency,
// amount) AND the exact same set of learned description patterns, no signal
// can ever separate them — declaring "ambiguous" for every future payment
// would create permanent manual work for zero benefit, since any pairing
// between them is equally correct (the obligations are identical).
//
// When the number of such indistinguishable, still-open occurrences equals
// the number of unclaimed matching candidate transactions, pair them up
// one-to-one (stable order: tx by occurredAt asc, recurring by dayOfMonth
// then id asc). If the counts differ, link as many pairs as possible and
// leave the remainder to the normal per-recurring resolution below (which
// creates a gap for anything still unmatched) — this never double-claims a
// transaction and never touches a skipped month (skipped recurrings are
// already excluded from `members` by the caller).
// ---------------------------------------------------------------------------

type ToProcessRow = {
  id: number;
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  dayOfMonth: number;
  skippedMonths: string[];
};

async function resolveBijectiveGroups(
  userId: number,
  year: number,
  month: number,
  yearMonth: string,
  toProcess: ToProcessRow[],
  database: DB,
): Promise<{ handled: Set<number>; autoLinked: number }> {
  const handled = new Set<number>();
  let autoLinked = 0;

  const groups = new Map<string, ToProcessRow[]>();
  for (const r of toProcess) {
    const key = `${r.accountId}:${r.currency}:${r.amountCents}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;

    const patternMap = await fetchPatterns(
      userId,
      members.map((m) => m.id),
      database,
    );
    const patternSets = members.map((m) => new Set(patternMap.get(m.id) ?? []));
    const sharedPatterns = patternSets[0]!;
    const allIdentical = patternSets.every((s) => patternSetsEqual(s, sharedPatterns));
    if (!allIdentical) continue; // a real distinguishing signal exists — resolve individually below

    const windows = members.map((m) => occurrenceWindow(year, month, m.dayOfMonth));
    const rangeStart = new Date(Math.min(...windows.map((w) => w.start.getTime())));
    const rangeEnd = new Date(Math.max(...windows.map((w) => w.endExclusive.getTime())));

    const { accountId, currency, amountCents } = members[0]!;

    const candidateTxs = await database
      .select({
        id: transactions.id,
        occurredAt: transactions.occurredAt,
        descriptionRaw: transactions.descriptionRaw,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNull(transactions.recurringId),
          eq(transactions.accountId, accountId),
          eq(transactions.currency, currency),
          eq(transactions.amountCents, amountCents),
          gte(transactions.occurredAt, rangeStart),
          lt(transactions.occurredAt, rangeEnd),
          notDeleted(transactions.deletedAt),
        ),
      )
      // Deterministic order — the cron re-runs monthly and must not reshuffle
      // prior pairings when two txs share an occurredAt timestamp.
      .orderBy(asc(transactions.occurredAt), asc(transactions.id));

    // Only candidates whose own token doesn't actively contradict the shared
    // pattern set are eligible — mirrors the KFC guard. An EMPTY shared
    // pattern set means "nothing learned yet" (bootstrap) — nothing to
    // contradict — so it passes through, exactly like the single-classic
    // path in resolveTxWinner()/auto-link.ts's resolveCandidate(). Treating
    // an empty set as "matches nothing" here would silently defeat the
    // feature on the very first month two indistinguishable recurrings exist.
    const eligibleTxs = candidateTxs.filter((tx) => {
      if (sharedPatterns.size === 0) return true;
      const token = tokeniseDescription(tx.descriptionRaw);
      return token === null || sharedPatterns.has(token);
    });
    if (eligibleTxs.length === 0) continue;

    const sortedTxs = [...eligibleTxs].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id,
    );
    const sortedMembers = [...members].sort((a, b) => a.dayOfMonth - b.dayOfMonth || a.id - b.id);

    const pairCount = Math.min(sortedTxs.length, sortedMembers.length);
    for (let i = 0; i < pairCount; i++) {
      const tx = sortedTxs[i]!;
      const member = sortedMembers[i]!;
      const updated = await database
        .update(transactions)
        .set({ recurringId: member.id, recurringYearMonth: yearMonth, updatedAt: new Date() })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, tx.id),
            isNull(transactions.recurringId),
          ),
        )
        .returning({ id: transactions.id });
      if (updated.length === 0) continue;
      autoLinked += 1;
      handled.add(member.id);
      await deleteOpenGap(userId, member.id, yearMonth, database);
    }
  }

  return { handled, autoLinked };
}

// ---------------------------------------------------------------------------
// #857: exact-then-near leftover matching for drifted amounts when twins
// share a description fingerprint.
//
// This is NOT an extension of resolveBijectiveGroups(). That function
// groups by identical (account, currency, amount) because any pairing
// between indistinguishable twins is equally correct. Aida/Alejo have
// DIFFERENT amounts — pairing by dayOfMonth+id would be a guess, and a
// wrong link is silent. The protocol is:
//   1. Assign unique exact-amount classic matches first.
//   2. Among leftovers, assign a near-amount match only when the edge is
//      1-1 (exactly one remaining recurring within 1% of that tx AND
//      exactly one remaining tx within 1% of that recurring).
//   3. A tx within 1% of two still-available recurrings is blocked —
//      ambiguity abstains, including against the later unique-token path
//      in the per-recurring loop (which would otherwise steal it for
//      whichever recurring happens to have the lowest id).
// ---------------------------------------------------------------------------

type WindowedTxRow = {
  id: number;
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  descriptionRaw: string | null;
  occurredAt: Date;
};

function txInOccurrenceWindow(occurredAt: Date, win: { start: Date; endExclusive: Date }): boolean {
  const t = occurredAt.getTime();
  return t >= win.start.getTime() && t < win.endExclusive.getTime();
}

function tokenCompatibleExact(patterns: string[], descriptionRaw: string | null): boolean {
  const token = tokeniseDescription(descriptionRaw);
  if (token === null) return true;
  return patterns.length === 0 || patterns.includes(token);
}

function tokenCompatibleNear(patterns: string[], descriptionRaw: string | null): boolean {
  // Near-amount is weaker than exact classic — do not bootstrap on an
  // empty pattern set, and do not amount-match a null/unrelated token.
  // Shared fingerprint (the #857 shape) is the only near-amount signal.
  const token = tokeniseDescription(descriptionRaw);
  return token !== null && patterns.includes(token);
}

async function claimUnlinkedTx(
  userId: number,
  txId: number,
  recurringId: number,
  yearMonth: string,
  database: DB,
): Promise<boolean> {
  const updated = await database
    .update(transactions)
    .set({ recurringId, recurringYearMonth: yearMonth, updatedAt: new Date() })
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, txId),
        isNull(transactions.recurringId),
      ),
    )
    .returning({ id: transactions.id });
  return updated.length > 0;
}

async function resolveExactThenNearAmount(
  userId: number,
  year: number,
  month: number,
  yearMonth: string,
  remaining: ToProcessRow[],
  database: DB,
): Promise<{ handled: Set<number>; autoLinked: number; blockedTxIds: Set<number> }> {
  const handled = new Set<number>();
  const blockedTxIds = new Set<number>();
  let autoLinked = 0;
  if (remaining.length === 0) return { handled, autoLinked, blockedTxIds };

  const windows = new Map(
    remaining.map((r) => [r.id, occurrenceWindow(year, month, r.dayOfMonth)] as const),
  );
  const rangeStart = new Date(Math.min(...[...windows.values()].map((w) => w.start.getTime())));
  const rangeEnd = new Date(
    Math.max(...[...windows.values()].map((w) => w.endExclusive.getTime())),
  );

  const candidateTxs: WindowedTxRow[] = await database
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      occurredAt: transactions.occurredAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.recurringId),
        gte(transactions.occurredAt, rangeStart),
        lt(transactions.occurredAt, rangeEnd),
        notDeleted(transactions.deletedAt),
      ),
    );

  const patternMap = await fetchPatterns(
    userId,
    remaining.map((r) => r.id),
    database,
  );

  const claimedTxIds = new Set<number>();

  const eligibleFor = (
    r: ToProcessRow,
    tx: WindowedTxRow,
    tokenOk: (patterns: string[], descriptionRaw: string | null) => boolean,
  ): boolean => {
    const win = windows.get(r.id)!;
    return (
      txInOccurrenceWindow(tx.occurredAt, win) &&
      tx.accountId === r.accountId &&
      tx.currency === r.currency &&
      tokenOk(patternMap.get(r.id) ?? [], tx.descriptionRaw)
    );
  };

  // Pass 1 — unique exact-amount classic matches.
  const exactByTx = new Map<number, number[]>();
  for (const r of remaining) {
    const exact = candidateTxs.filter(
      (tx) => eligibleFor(r, tx, tokenCompatibleExact) && tx.amountCents === r.amountCents,
    );
    if (exact.length !== 1) continue;
    const txId = exact[0]!.id;
    const owners = exactByTx.get(txId) ?? [];
    owners.push(r.id);
    exactByTx.set(txId, owners);
  }
  for (const [txId, owners] of exactByTx) {
    if (owners.length !== 1) continue;
    const recurringId = owners[0]!;
    const claimed = await claimUnlinkedTx(userId, txId, recurringId, yearMonth, database);
    if (!claimed) continue;
    handled.add(recurringId);
    claimedTxIds.add(txId);
    autoLinked += 1;
  }

  const leftoverRecurrings = remaining.filter((r) => !handled.has(r.id));
  const leftoverTxs = candidateTxs.filter((tx) => !claimedTxIds.has(tx.id));

  // Pass 2 — 1-1 near-amount leftovers. Degree ≥ 2 on either side abstains.
  const nearEdges: { recurringId: number; txId: number }[] = [];
  for (const r of leftoverRecurrings) {
    for (const tx of leftoverTxs) {
      if (!eligibleFor(r, tx, tokenCompatibleNear)) continue;
      if (!isWithinAmountTolerance(r.amountCents, tx.amountCents, r.currency, tx.currency)) {
        continue;
      }
      nearEdges.push({ recurringId: r.id, txId: tx.id });
    }
  }

  const recDegree = new Map<number, number>();
  const txDegree = new Map<number, number>();
  for (const e of nearEdges) {
    recDegree.set(e.recurringId, (recDegree.get(e.recurringId) ?? 0) + 1);
    txDegree.set(e.txId, (txDegree.get(e.txId) ?? 0) + 1);
  }
  for (const [txId, degree] of txDegree) {
    if (degree >= 2) blockedTxIds.add(txId);
  }

  for (const e of nearEdges) {
    if ((txDegree.get(e.txId) ?? 0) !== 1) continue;
    if ((recDegree.get(e.recurringId) ?? 0) !== 1) continue;
    const claimed = await claimUnlinkedTx(userId, e.txId, e.recurringId, yearMonth, database);
    if (!claimed) continue;
    handled.add(e.recurringId);
    autoLinked += 1;
  }

  return { handled, autoLinked, blockedTxIds };
}

/**
 * For a single closed month, reconcile every active recurring against
 * transactions. Three branches per recurring:
 *   1. Already linked (recurring_id + recurring_year_month set on a tx) — done.
 *   2. Exactly one unlinked tx falls in the occurrence's slot-claim window
 *      (src/lib/recurring/slot.ts) and resolves via the classic
 *      account+amount match or the description-fingerprint scorer — auto-link it.
 *      Genuinely indistinguishable recurrings (same account+amount+patterns)
 *      are resolved together via bijective pairing first — see
 *      resolveBijectiveGroups() above.
 *   3. Otherwise — insert into recurring_gaps for manual resolution.
 *
 * skippedMonths entries on the recurring are respected: those months are not
 * gaps, the user already said "this month was intentionally not paid" — this
 * check happens BEFORE any candidate is even considered (#804: the only
 * thing that can void an occurrence).
 *
 * #804: no longer requires the candidate tx to share the recurring's account
 * — see resolveTxWinner() above.
 *
 * Idempotent: re-running on the same month is a no-op thanks to the unique
 * index on recurring_gaps(recurring_id, year_month) + ON CONFLICT DO NOTHING
 * and the unique link index on transactions.
 */
export async function detectGapsForMonth(
  userId: number,
  yearMonth: string,
  database: DB = defaultDb,
): Promise<DetectResult> {
  const { year, month } = parseYearMonth(yearMonth);

  const recurrings = await database
    .select({
      id: recurringTransactions.id,
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

  const result: DetectResult = {
    yearMonth,
    checkedRecurrings: recurrings.length,
    existingLinks: 0,
    autoLinked: 0,
    skippedIntentionally: 0,
    gapsCreated: 0,
    gapsAlreadyOpen: 0,
  };

  if (recurrings.length === 0) return result;

  const recurringIds = recurrings.map((r) => r.id);

  const existingLinks = await database
    .select({ recurringId: transactions.recurringId })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.recurringId, recurringIds),
        eq(transactions.recurringYearMonth, yearMonth),
        notDeleted(transactions.deletedAt),
      ),
    );
  const linkedSet = new Set(existingLinks.map((l) => l.recurringId as number));

  const toProcess: ToProcessRow[] = [];
  for (const r of recurrings) {
    if (linkedSet.has(r.id)) {
      result.existingLinks += 1;
      // #844: a leftover open gap for an already-linked occurrence makes the
      // gap list untrustworthy. Drop it.
      await deleteOpenGap(userId, r.id, yearMonth, database);
      continue;
    }
    // #804: explicit skip is the only thing that voids an occurrence — check
    // it before considering any candidate.
    if ((r.skippedMonths ?? []).includes(yearMonth)) {
      result.skippedIntentionally += 1;
      continue;
    }
    toProcess.push({
      id: r.id,
      accountId: r.accountId,
      amountCents: r.amountCents,
      currency: r.currency,
      dayOfMonth: r.dayOfMonth,
      skippedMonths: r.skippedMonths ?? [],
    });
  }

  const { handled, autoLinked: bijectiveAutoLinked } = await resolveBijectiveGroups(
    userId,
    year,
    month,
    yearMonth,
    toProcess,
    database,
  );
  result.autoLinked += bijectiveAutoLinked;

  const leftover = toProcess.filter((r) => !handled.has(r.id));
  const {
    handled: nearHandled,
    autoLinked: nearAutoLinked,
    blockedTxIds,
  } = await resolveExactThenNearAmount(userId, year, month, yearMonth, leftover, database);
  for (const id of nearHandled) handled.add(id);
  result.autoLinked += nearAutoLinked;

  for (const r of toProcess) {
    if (handled.has(r.id)) continue;

    const win = occurrenceWindow(year, month, r.dayOfMonth);

    const candidates = await database
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        currency: transactions.currency,
        descriptionRaw: transactions.descriptionRaw,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNull(transactions.recurringId),
          gte(transactions.occurredAt, win.start),
          lt(transactions.occurredAt, win.endExclusive),
          notDeleted(transactions.deletedAt),
        ),
      );

    const winner = await resolveTxWinner(userId, r, candidates, database);
    // #857: a tx within 1% of two still-available recurrings must not be
    // stolen by the unique-token path of whichever recurring the loop
    // happens to visit first (lowest id / insert order).
    const winnerIsBlocked = winner !== null && blockedTxIds.has(winner.id);

    if (winner && !winnerIsBlocked) {
      const updated = await database
        .update(transactions)
        .set({
          recurringId: r.id,
          recurringYearMonth: yearMonth,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.id, winner.id),
            // Race guard — "one tx links to at most one occurrence" (#804):
            // without this, a concurrent writer that claimed this tx between
            // the SELECT above and this UPDATE could be silently overwritten.
            isNull(transactions.recurringId),
          ),
        )
        .returning({ id: transactions.id });
      if (updated.length > 0) {
        result.autoLinked += 1;
        // #844: if a gap for this month was already opened (tx arrived before
        // the detector ran, or a previous run used a tighter window), close it
        // now that the occurrence is linked.
        await deleteOpenGap(userId, r.id, yearMonth, database);
      }
      continue;
    }

    const inserted = await database
      .insert(recurringGaps)
      .values({
        userId,
        recurringId: r.id,
        yearMonth,
      })
      .onConflictDoNothing({
        target: [recurringGaps.recurringId, recurringGaps.yearMonth],
      })
      .returning({ id: recurringGaps.id });

    if (inserted.length > 0) {
      result.gapsCreated += 1;
      const gapId = inserted[0]!.id;
      emitNotification(userId, {
        type: "recurring_gap_detected",
        entityId: String(gapId),
        title: "Recurrente sin movimiento detectado",
        body: "Esperábamos un cargo este período y no llegó. Confirmá si lo recibiste por otro canal o si saltó este mes.",
        actionUrl: "/settings/recurring",
        priority: "medium",
        metadata: {
          recurringId: r.id,
          gapId,
          yearMonth,
          expectedAmountCents: r.amountCents,
        },
      }).catch((err: unknown) => {
        log.error(
          { err, userId, gapId, event: "recurring_gap_emit_failed" },
          "failed to emit recurring_gap_detected notification",
        );
      });
    } else {
      result.gapsAlreadyOpen += 1;
    }
  }

  return result;
}

export type ReconcileResult = {
  gapsExamined: number;
  autoLinked: number;
  staleGapsDeleted: number;
};

/**
 * Re-examine every still-open gap for this user and either:
 *   - auto-link a matching unlinked tx that now falls in the occurrence
 *     window (and delete the gap), or
 *   - delete the gap if the occurrence is already linked, or
 *   - leave it open if nothing matches.
 *
 * Does NOT create new gaps. That is detectGapsForMonth's job. This is the
 * #844 "nothing reconsiders the transaction once its gap finally appears"
 * pass: closePreviousMonth only closes M-1, so older open gaps would
 * otherwise stay open forever even after a matching tx exists.
 */
export async function reconcileOpenGaps(
  userId: number,
  database: DB = defaultDb,
): Promise<ReconcileResult> {
  const openGaps = await database
    .select({
      gapId: recurringGaps.id,
      yearMonth: recurringGaps.yearMonth,
      recurringId: recurringTransactions.id,
      accountId: recurringTransactions.accountId,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      dayOfMonth: recurringTransactions.dayOfMonth,
      skippedMonths: recurringTransactions.skippedMonths,
    })
    .from(recurringGaps)
    .innerJoin(
      recurringTransactions,
      and(
        eq(recurringTransactions.id, recurringGaps.recurringId),
        eq(recurringTransactions.userId, recurringGaps.userId),
      ),
    )
    .where(
      and(
        eq(recurringGaps.userId, userId),
        eq(recurringTransactions.userId, userId),
        isNull(recurringGaps.resolution),
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

  const result: ReconcileResult = {
    gapsExamined: openGaps.length,
    autoLinked: 0,
    staleGapsDeleted: 0,
  };

  for (const gap of openGaps) {
    if ((gap.skippedMonths ?? []).includes(gap.yearMonth)) {
      await deleteOpenGap(userId, gap.recurringId, gap.yearMonth, database);
      result.staleGapsDeleted += 1;
      continue;
    }

    const alreadyLinked = await database
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.recurringId, gap.recurringId),
          eq(transactions.recurringYearMonth, gap.yearMonth),
          notDeleted(transactions.deletedAt),
        ),
      )
      .limit(1);
    if (alreadyLinked.length > 0) {
      await deleteOpenGap(userId, gap.recurringId, gap.yearMonth, database);
      result.staleGapsDeleted += 1;
      continue;
    }

    const { year, month } = parseYearMonth(gap.yearMonth);
    const win = occurrenceWindow(year, month, gap.dayOfMonth);
    const candidates = await database
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        currency: transactions.currency,
        descriptionRaw: transactions.descriptionRaw,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNull(transactions.recurringId),
          gte(transactions.occurredAt, win.start),
          lt(transactions.occurredAt, win.endExclusive),
          notDeleted(transactions.deletedAt),
        ),
      );

    const winner = await resolveTxWinner(
      userId,
      {
        id: gap.recurringId,
        accountId: gap.accountId,
        amountCents: gap.amountCents,
        currency: gap.currency,
      },
      candidates,
      database,
    );
    if (!winner) continue;

    const updated = await database
      .update(transactions)
      .set({
        recurringId: gap.recurringId,
        recurringYearMonth: gap.yearMonth,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, winner.id),
          isNull(transactions.recurringId),
        ),
      )
      .returning({ id: transactions.id });
    if (updated.length === 0) continue;

    await deleteOpenGap(userId, gap.recurringId, gap.yearMonth, database);
    result.autoLinked += 1;
  }

  log.info(
    {
      event: "reconcile_open_gaps",
      userId,
      gapsExamined: result.gapsExamined,
      autoLinked: result.autoLinked,
      staleGapsDeleted: result.staleGapsDeleted,
    },
    "reconciled open recurring gaps",
  );

  return result;
}

/**
 * Entry point for the cron. Closes the month PRIOR to `today` so that
 * late-posting SMS/Apple Pay events have a 4-day grace window before we
 * finalize gaps, then reconsiders every still-open gap from earlier months
 * (#844 — a matching tx ingested before its gap existed must not stay
 * orphaned forever).
 */
export async function closePreviousMonth(
  userId: number,
  today: Date = new Date(),
  database: DB = defaultDb,
): Promise<DetectResult> {
  const result = await detectGapsForMonth(userId, previousYearMonth(today), database);
  await reconcileOpenGaps(userId, database);
  return result;
}

export type UserCloseResult =
  | { userId: number; ok: true; result: DetectResult }
  | { userId: number; ok: false; error: unknown };

/**
 * Fan-out wrapper for the monthly cron. Runs closePreviousMonth for every
 * user sequentially; a failure on one user is captured and does not stop the
 * rest. Callers are responsible for logging / alerting on the returned list.
 */
export async function closePreviousMonthForAllUsers(
  today: Date = new Date(),
  database: DB = defaultDb,
): Promise<UserCloseResult[]> {
  const rows = await database.select({ id: users.id }).from(users).orderBy(asc(users.id));
  const out: UserCloseResult[] = [];
  for (const { id } of rows) {
    try {
      const result = await closePreviousMonth(id, today, database);
      out.push({ userId: id, ok: true, result });
    } catch (error) {
      out.push({ userId: id, ok: false, error });
    }
  }
  return out;
}
