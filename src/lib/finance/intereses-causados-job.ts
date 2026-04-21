// #407: monthly job that computes the interest accrued on a credit card for
// a cycle and persists it as a single synthetic transaction under the
// `intereses-tc` category (seeded in #405).
//
// The expensive bit — the per-purchase schedule — already lives in
// `installment-schedule.ts`. This module's job is ledger-side:
//   1. Resolve the live installment purchases on the TC.
//   2. Compute each one's current balance and interest for the cycle.
//   3. Sum them and emit ONE synthetic tx.
//   4. Skip if the cycle already has an interest tx for this account
//      (idempotency via `raw_data.cycleKey`).
//
// The output is intentionally a single tx per cycle (not one per purchase)
// because that's what Bancolombia extracts do — the user sees a single
// "INTERESES CORRIENTES $X" line on their statement, not one per compra.

import { and, eq, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { accounts, transactions, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { installmentSchedule } from "@/lib/finance/installment-schedule";
import { resolveBucketRateBps } from "@/lib/finance/rates";

export type CycleKey = `${number}-${string}`; // e.g. "5-2026-04"

export type InterestRun = {
  accountId: number;
  cycle: string; // YYYY-MM
  intereses: Array<{
    txId: number;
    purchaseAmountCents: bigint;
    rateEMBps: number;
    installmentsTotal: number;
    installmentsPaid: number;
    outstandingBeforeCents: bigint;
    interestCents: bigint;
  }>;
  totalInterestCents: bigint;
};

export type ApplyResult =
  | { status: "inserted"; txId: number; totalInterestCents: bigint }
  | { status: "skipped"; reason: "zero-interest" | "already-run" }
  | { status: "error"; reason: string };

function cycleKeyFor(accountId: number, cycle: string): string {
  return `${accountId}-${cycle}`;
}

// Convert a "YYYY-MM" cycle string into a UTC mid-month date. Used as the
// `occurred_at` anchor for the synthetic tx and the `today` input to the
// schedule helper — being mid-month keeps it insensitive to TZ edges.
function cycleAnchor(cycle: string): Date {
  const [y, m] = cycle.split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m)) throw new Error(`invalid cycle: ${cycle}`);
  return new Date(Date.UTC(y, m - 1, 15, 12, 0, 0, 0));
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
  const anchor = cycleAnchor(cycle);

  const [account] = await database
    .select({
      id: accounts.id,
      type: accounts.type,
      currency: accounts.currency,
      metadata: accounts.metadata,
    })
    .from(accounts)
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

  // Live installment purchases: TC txs with installments_total > 0 and
  // negative amount (purchases, not credits / payments), occurring on or
  // before the cycle anchor. Soft-deleted rows excluded.
  const purchases = await database
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      installmentsTotal: transactions.installmentsTotal,
      installmentRateBps: transactions.installmentRateBps,
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

  for (const p of purchases) {
    const rateBps =
      p.installmentRateBps != null
        ? p.installmentRateBps
        : (resolveBucketRateBps(buckets, p.installmentsTotal) ?? 0);

    const schedule = installmentSchedule({
      amountCents: -p.amountCents, // stored negative, helper expects positive magnitude
      rateEMBps: rateBps,
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
    if (interestCents === BigInt(0)) continue;

    const outstandingBefore =
      schedule.paidCount === 0
        ? -p.amountCents
        : schedule.rows[schedule.paidCount - 1].balanceAfterCents;

    intereses.push({
      txId: p.id,
      purchaseAmountCents: -p.amountCents,
      rateEMBps: rateBps,
      installmentsTotal: p.installmentsTotal,
      installmentsPaid: schedule.paidCount,
      outstandingBeforeCents: outstandingBefore,
      interestCents,
    });
    totalInterestCents += interestCents;
  }

  return { accountId, cycle, intereses, totalInterestCents };
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
    return { status: "skipped", reason: "already-run" };
  }

  const run = await computeInterestForCycle({ userId, accountId, cycle, database });
  if (run.totalInterestCents === BigInt(0)) {
    return { status: "skipped", reason: "zero-interest" };
  }

  try {
    const anchor = cycleAnchor(cycle);
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
            rateEMBps: i.rateEMBps,
            installmentsTotal: i.installmentsTotal,
            installmentsPaid: i.installmentsPaid,
            outstandingBeforeCents: i.outstandingBeforeCents.toString(),
            interestCents: i.interestCents.toString(),
          })),
        },
      })
      .returning({ id: transactions.id });

    return {
      status: "inserted",
      txId: inserted.id,
      totalInterestCents: run.totalInterestCents,
    };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
