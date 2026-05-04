// #407: monthly job that computes the interest accrued on a credit card for
// a cycle and persists it as a single synthetic transaction under the
// `intereses-tc` category (seeded in #405).
//
// The expensive bit — the per-purchase schedule — already lives in
// `installment-schedule.ts`. This module's job is ledger-side:
//   1. Resolve the live installment purchases on the TC.
//   2. For each, project the installment schedule as of the cycle anchor and
//      extract the cycle's interest (single pass per purchase).
//   3. Sum them and emit ONE synthetic tx.
//   4. Skip if the cycle already has an interest tx for this account
//      (idempotency via `raw_data.cycleKey`).
//
// The output is intentionally a single tx per cycle (not one per purchase)
// because that's what Bancolombia extracts do — the user sees a single
// "INTERESES CORRIENTES $X" line on their statement, not one per compra.
//
// NOTE: There is NO partial-month accrual for grace-month-1 (cuota 1/N)
// purchases. Real Bancolombia statements show Intereses corrientes 0,00 for
// those rows; the "días-activos prorrateo" second pass added in #565 was
// removed in #778 after extracto evidence proved it charges phantom interest.

import { and, eq, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { accounts, physicalCards, transactions, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { installmentSchedule } from "@/lib/finance/installment-schedule";
import { resolveBucketRateX10k } from "@/lib/finance/rates";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "intereses-causados-job" });

// Fallback cut day when neither the account nor its linked physical card has
// one configured. 31 clamps to each month's last day, so a misconfigured
// account still produces end-of-cycle behavior (the safest generic for
// Bancolombia-style TCs). A warning is logged so the gap is visible.
const DEFAULT_CUT_DAY = 31;

export type CycleKey = `${number}-${string}`; // e.g. "5-2026-04"

export type InterestRun = {
  accountId: number;
  cycle: string; // YYYY-MM
  // Anchor used to split paid vs pending cuotas — end-of-day on the account's
  // statement cut day, clamped to the month's last day. Surfaced so the
  // apply-path can reuse it as the synthetic tx's `occurred_at` without
  // re-resolving the cut day. See #413.
  anchor: Date;
  intereses: Array<{
    txId: number;
    purchaseAmountCents: bigint;
    rateEmX10k: number; // #411: percent × 10000
    installmentsTotal: number;
    installmentsPaid: number;
    outstandingBeforeCents: bigint;
    interestCents: bigint;
    // #416: true when the tx is multi-cuota but neither an explicit rate nor
    // a matching bucket was found. Interest can't be computed; the row is
    // surfaced so the UI can prompt for a rate. `interestCents` is 0n.
    needsRate: boolean;
    gracePeriodPartialCents: bigint; // #778: always 0n — kept for read-compat with prod synthetic txs.
  }>;
  totalInterestCents: bigint;
  // #416: convenience count of rows with `needsRate: true`. Callers (CLI,
  // future UI) use it to decide whether to warn the user that the run is
  // incomplete.
  purchasesNeedingRate: number;
};

export type ApplyResult =
  | {
      status: "inserted";
      txId: number;
      totalInterestCents: bigint;
      // #416: non-zero when some purchases couldn't be priced. The synthetic
      // tx still ships with the partial total; callers surface the gap.
      purchasesNeedingRate: number;
    }
  | {
      status: "skipped";
      reason: "zero-interest" | "already-run";
      // #416: surfaced even on zero-interest skips — a cycle may have only
      // needs-rate purchases and no priced ones; the user still needs to see
      // the gap.
      purchasesNeedingRate: number;
    }
  | { status: "error"; reason: string };

function cycleKeyFor(accountId: number, cycle: string): string {
  return `${accountId}-${cycle}`;
}

// Convert a "YYYY-MM" cycle string into the anchor Date for that cycle's
// statement cut. `cutDay` (1-31) is the account's statement close day; values
// past the month's actual length are clamped to the last day (e.g. cutDay=31
// in February becomes Feb 28/29). End-of-day UTC (23:00) so purchases made
// earlier in that same day still count as paid for `monthsBetween` checks.
//
// Why this drives correctness: `installmentSchedule`'s paid-vs-pending split
// calls `monthsBetween(purchaseDate, anchor)` — anchoring mid-month would
// decrement the count whenever a purchase's day-of-month falls in the second
// half, producing a one-cuota-behind interest calc. See #413.
export function cycleAnchor(cycle: string, cutDay: number): Date {
  const [y, m] = cycle.split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m)) throw new Error(`invalid cycle: ${cycle}`);
  if (!Number.isInteger(cutDay) || cutDay < 1 || cutDay > 31) {
    throw new Error(`invalid cutDay: ${cutDay}`);
  }
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(cutDay, lastDayOfMonth);
  return new Date(Date.UTC(y, m - 1, day, 23, 0, 0, 0));
}

// For each live installment purchase on the TC, project its schedule as of
// the cycle anchor and extract the cycle's interest. Purely computational —
// no DB writes, so it's safe to call from UI handlers for previews.
export async function computeInterestForCycle(opts: {
  userId: number;
  accountId: number;
  cycle: string; // "YYYY-MM"
  database?: DB;
}): Promise<InterestRun> {
  const { userId, accountId, cycle, database = db } = opts;

  // Left-join physical_cards so shared-cupo multi-currency cards (Mastercard
  // Internacional, Amex) pick up the cut day from the shared row rather than
  // duplicating it in every linked account's metadata.
  const [account] = await database
    .select({
      id: accounts.id,
      type: accounts.type,
      currency: accounts.currency,
      metadata: accounts.metadata,
      physicalCardCutoffDay: physicalCards.statementCutoffDay,
    })
    .from(accounts)
    .leftJoin(physicalCards, eq(physicalCards.id, accounts.physicalCardId))
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);

  if (!account) throw new Error(`account ${accountId} not found for user ${userId}`);
  if (account.type !== "credit_card") {
    throw new Error(`account ${accountId} is not a credit card`);
  }
  const meta = account.metadata as AccountMetadata;
  const buckets = meta.creditRateBuckets;

  // Prefer the physical card's cut day (shared across linked currency pairs)
  // then the per-account override in metadata, falling back to last-day-of-
  // month when nothing is configured. The fallback path logs so the config
  // gap is observable — see #413.
  let cutDay = account.physicalCardCutoffDay ?? meta.cutoffDay ?? null;
  if (cutDay == null) {
    log.warn(
      { userId, accountId, cycle, event: "cutoff_day_missing" },
      "account has no cutoffDay configured — defaulting to last day of month",
    );
    cutDay = DEFAULT_CUT_DAY;
  }
  const anchor = cycleAnchor(cycle, cutDay);

  // Live installment purchases: TC txs with installments_total > 0 and
  // negative amount (purchases, not credits / payments), occurring on or
  // before the cycle anchor. Soft-deleted rows excluded.
  const purchases = await database
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      installmentsTotal: transactions.installmentsTotal,
      installmentRateEmX10k: transactions.installmentRateEmX10k,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        sql`${transactions.amountCents} < 0`,
        sql`${transactions.installmentsTotal} >= 1`,
        sql`${transactions.occurredAt} <= ${anchor.toISOString()}`,
        notDeleted(transactions.deletedAt),
        // Exclude txs with no interest potential (rate 0 AND 1 cuota). We
        // still pull installments_total=1 because it's the default; the
        // bucket lookup below will return 0 for those under the oneMonth
        // bucket, producing no-interest rows that we drop downstream.
      ),
    );

  const intereses: InterestRun["intereses"] = [];
  let totalInterestCents = BigInt(0);
  let purchasesNeedingRate = 0;

  for (const p of purchases) {
    // #416: resolve rate without a silent `?? 0`. Precedence:
    //   1. per-tx explicit rate (regla 3 — tasa inmutable por tx)
    //   2. account bucket that matches installments_total
    //   3. no fuente → needsRate flag; rate stays 0 so the schedule helper
    //      returns zero interest (correct math: interés indefinido ≠ 0; we
    //      surface the gap instead of booking a wrong number).
    // 1-cuota sin fuente se marca NO como needsRate porque cuota única
    // nunca genera interés (Bancolombia "diferido sin intereses").
    let rateEmX10k: number;
    let needsRate = false;
    if (p.installmentRateEmX10k != null) {
      rateEmX10k = p.installmentRateEmX10k;
    } else {
      const bucketRate = resolveBucketRateX10k(buckets, p.installmentsTotal);
      if (bucketRate != null) {
        rateEmX10k = bucketRate;
      } else {
        rateEmX10k = 0;
        if (p.installmentsTotal > 1) needsRate = true;
      }
    }

    const schedule = installmentSchedule({
      amountCents: -p.amountCents, // stored negative, helper expects positive magnitude
      rateEmX10k,
      installments: p.installmentsTotal,
      graceMonth: true, // Bancolombia default per regla 4; safe for extracts today
      purchaseDate: p.occurredAt,
      today: anchor,
    });

    // The cycle's interest is the interest scheduled for the next unpaid
    // month. If the loan is fully paid before `anchor`, skip.
    if (schedule.paidCount >= schedule.rows.length) continue;
    const nextRow = schedule.rows[schedule.paidCount];
    const interestCents = nextRow.interestCents + nextRow.deferredInterestCents;
    // #416: drop zero-interest priced rows (unchanged behavior), but KEEP
    // `needsRate` rows even though their interestCents is 0 — the UI uses
    // them to prompt for a rate.
    if (interestCents === BigInt(0) && !needsRate) continue;

    const outstandingBefore =
      schedule.paidCount === 0
        ? -p.amountCents
        : schedule.rows[schedule.paidCount - 1].balanceAfterCents;

    intereses.push({
      txId: p.id,
      purchaseAmountCents: -p.amountCents,
      rateEmX10k,
      installmentsTotal: p.installmentsTotal,
      installmentsPaid: schedule.paidCount,
      outstandingBeforeCents: outstandingBefore,
      interestCents,
      needsRate,
      gracePeriodPartialCents: BigInt(0), // #778: always 0 — partial-month prorrateo removed
    });
    if (needsRate) purchasesNeedingRate += 1;
    else totalInterestCents += interestCents;
  }

  return { accountId, cycle, anchor, intereses, totalInterestCents, purchasesNeedingRate };
}

// Persist the cycle's interest as a synthetic tx. Idempotent — second call
// for the same `(accountId, cycle)` returns `skipped / already-run`.
export async function applyInteresesCausadosForCycle(opts: {
  userId: number;
  accountId: number;
  cycle: string;
  database?: DB;
}): Promise<ApplyResult> {
  const { userId, accountId, cycle, database = db } = opts;
  const key = cycleKeyFor(accountId, cycle);

  // Idempotency guard — look for a prior synthetic tx on this account+cycle.
  const existing = await database.execute<{ id: number }>(sql`
    SELECT id FROM transactions
    WHERE user_id = ${userId}
      AND account_id = ${accountId}
      AND category_slug = 'intereses-tc'
      AND raw_data ->> 'cycleKey' = ${key}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length > 0) {
    // Already-run skips still need a purchasesNeedingRate count — even if the
    // synthetic already exists, new purchases added since then may need rate.
    const run = await computeInterestForCycle({ userId, accountId, cycle, database });
    return {
      status: "skipped",
      reason: "already-run",
      purchasesNeedingRate: run.purchasesNeedingRate,
    };
  }

  const run = await computeInterestForCycle({ userId, accountId, cycle, database });
  if (run.totalInterestCents === BigInt(0)) {
    return {
      status: "skipped",
      reason: "zero-interest",
      purchasesNeedingRate: run.purchasesNeedingRate,
    };
  }

  try {
    const anchor = run.anchor;
    const cycleLabel = cycle; // already YYYY-MM
    const [accRow] = await database.execute<{ last4s: unknown; currency: "COP" | "USD" }>(sql`
      SELECT metadata -> 'last4s' AS last4s, currency
      FROM accounts WHERE id = ${accountId}
    `);
    const last4 = Array.isArray(accRow?.last4s)
      ? ((accRow.last4s as string[])[0] ?? "????")
      : "????";
    const accCurrency = accRow?.currency ?? "COP";

    const [inserted] = await database
      .insert(transactions)
      .values({
        userId,
        accountId,
        occurredAt: anchor,
        amountCents: -run.totalInterestCents, // interest is an expense — negative on the TC
        currency: accCurrency,
        descriptionRaw: `Intereses causados ciclo ${cycleLabel} — TC *${last4}`,
        merchant: null,
        categorySlug: "intereses-tc",
        classificationMethod: "manual",
        classificationConfidence: 100,
        source: "manual",
        channel: "manual",
        rawData: {
          job: "intereses-causados-job",
          cycleKey: key,
          cycle: cycleLabel,
          synthetic: true,
          breakdown: run.intereses.map((i) => ({
            txId: i.txId,
            amountCents: i.purchaseAmountCents.toString(),
            rateEmX10k: i.rateEmX10k,
            installmentsTotal: i.installmentsTotal,
            installmentsPaid: i.installmentsPaid,
            outstandingBeforeCents: i.outstandingBeforeCents.toString(),
            interestCents: i.interestCents.toString(),
            needsRate: i.needsRate,
            gracePeriodPartialCents: i.gracePeriodPartialCents.toString(),
          })),
          purchasesNeedingRate: run.purchasesNeedingRate,
        },
      })
      .returning({ id: transactions.id });

    return {
      status: "inserted",
      txId: inserted.id,
      totalInterestCents: run.totalInterestCents,
      purchasesNeedingRate: run.purchasesNeedingRate,
    };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
