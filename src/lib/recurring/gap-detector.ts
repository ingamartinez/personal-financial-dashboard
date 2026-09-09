import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  recurringDescriptionPatterns,
  recurringGaps,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { emitNotification } from "@/lib/notifications/emit";
import { pickTxForRecurring, type TxCandidate } from "@/lib/recurring/match-score";
import { occurrenceWindow } from "@/lib/recurring/slot";
import type { Currency } from "@/lib/types";

const log = createLogger({ module: "recurring/gap-detector" });

// Kept for backward compatibility — src/lib/recurring/gap-queries.ts (a
// separate, possibly-dead manual-link-candidate helper, see #804 issue notes)
// still uses these. detectGapsForMonth itself now uses the slot-claiming
// window (src/lib/recurring/slot.ts) instead.
const DEFAULT_WINDOW_BEFORE_DAYS = 10;
const DEFAULT_WINDOW_AFTER_DAYS = 5;

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

export function previousYearMonth(today: Date): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function fetchPatternsForOne(
  userId: number,
  recurringId: number,
  database: DB,
): Promise<string[]> {
  const rows = await database
    .select({ pattern: recurringDescriptionPatterns.pattern })
    .from(recurringDescriptionPatterns)
    .where(
      and(
        eq(recurringDescriptionPatterns.userId, userId),
        eq(recurringDescriptionPatterns.recurringId, recurringId),
      ),
    );
  return rows.map((r) => r.pattern);
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
 * recurring's payment for the occurrence, using the same classic
 * (account+amount) fast path, then description-fingerprint + amount scorer,
 * as auto-link.ts (#804) — see that file's resolveCandidate() for the
 * detailed rationale. Returns null when there is no signal or the
 * candidates remain ambiguous (both cases fall through to gap creation).
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
  if (classic.length === 1) return classic[0]!;

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

/**
 * For a single closed month, reconcile every active recurring against
 * transactions. Three branches per recurring:
 *   1. Already linked (recurring_id + recurring_year_month set on a tx) — done.
 *   2. Exactly one unlinked tx falls in the occurrence's slot-claim window
 *      (src/lib/recurring/slot.ts) and resolves via the classic
 *      account+amount match or the description-fingerprint scorer — auto-link it.
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

  for (const r of recurrings) {
    if (linkedSet.has(r.id)) {
      result.existingLinks += 1;
      continue;
    }

    // #804: explicit skip is the only thing that voids an occurrence — check
    // it before considering any candidate.
    if ((r.skippedMonths ?? []).includes(yearMonth)) {
      result.skippedIntentionally += 1;
      continue;
    }

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

    if (winner) {
      await database
        .update(transactions)
        .set({
          recurringId: r.id,
          recurringYearMonth: yearMonth,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, winner.id)));
      result.autoLinked += 1;
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

/**
 * Entry point for the cron. Closes the month PRIOR to `today` so that
 * late-posting SMS/Apple Pay events have a 4-day grace window before we
 * finalize gaps.
 */
export async function closePreviousMonth(
  userId: number,
  today: Date = new Date(),
  database: DB = defaultDb,
): Promise<DetectResult> {
  return detectGapsForMonth(userId, previousYearMonth(today), database);
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

export { DEFAULT_WINDOW_BEFORE_DAYS, DEFAULT_WINDOW_AFTER_DAYS };
