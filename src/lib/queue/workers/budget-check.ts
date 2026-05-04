import type { Job } from "bullmq";
import { aliasedTable, and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { budgets, categories, transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted, notInternalMovement } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { formatCop } from "@/lib/money";
import { emitNotification } from "@/lib/notifications/emit";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/budget-check" });

export type BudgetCheckJobData = Record<string, never>;

// ---------------------------------------------------------------------------
// Core logic — extracted for testability (no live Worker needed in tests).
// ---------------------------------------------------------------------------

/**
 * Returns the current yearMonth string in America/Bogota timezone.
 * Format: "YYYY-MM".
 */
export function getCurrentYearMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7); // "YYYY-MM"
}

export type BudgetRow = {
  userId: number;
  categorySlug: string;
  categoryName: string;
  amountCents: bigint;
  mtdCents: bigint;
  yearMonth: string;
};

/**
 * Fetch all active budgets for `yearMonth` and compute MTD spend per
 * (userId, categorySlug). Returns only rows where mtdCents >= amountCents.
 *
 * Tenant safety: every JOIN uses (user_id, slug) pairing — slug alone is NOT
 * unique across users. See memory `per-user-table-join-tenant-safety`
 * (incidents #336/#338 — 9× fanout + cross-tenant leak from slug-only JOIN).
 */
export async function fetchExceededBudgets(yearMonth: string): Promise<BudgetRow[]> {
  const [y, m] = yearMonth.split("-").map(Number);
  const periodStart = `${yearMonth}-01`;
  const windowStart = new Date(Date.UTC(y, m - 1, 1));
  const windowEnd = new Date(Date.UTC(y, m, 1));

  // Alias for the transactions→categories join so it doesn't collide with the
  // budgets→categories join in the outer context.
  const txCat = aliasedTable(categories, "tx_cat");

  // Step 1: Fetch all active budgets for this period, joined with their category
  // name. The JOIN uses (userId, categorySlug) — tenant-safe pairing.
  const activeBudgets = await db
    .select({
      userId: budgets.userId,
      categorySlug: budgets.categorySlug,
      categoryName: categories.name,
      amountCents: budgets.amountCents,
    })
    .from(budgets)
    .innerJoin(
      categories,
      and(eq(categories.userId, budgets.userId), eq(categories.slug, budgets.categorySlug)),
    )
    .where(
      and(
        eq(budgets.periodStart, periodStart),
        eq(budgets.active, true),
        notDeleted(budgets.deletedAt),
        notDeleted(categories.deletedAt),
      ),
    );

  if (activeBudgets.length === 0) {
    return [];
  }

  // Step 2: Compute MTD spend per (userId, categorySlug) over the month window.
  //
  // Spend = SUM of negative amountCents (expenses are stored as negative).
  // Matches the same formula used in getBudgetsOverview (queries.ts), including
  // the notInternalMovement filter that excludes TC payments, transfers, and ATM
  // withdrawals to prevent double-counting (#685, #766).
  //
  // The GROUP BY uses the root category slug (COALESCE parent_slug, slug) so
  // sub-categories roll up into their parent — consistent with getBudgetsOverview.
  //
  // Tenant safety: JOIN uses (txCat.userId, txCat.slug) = (transactions.userId,
  // transactions.categorySlug) — user_id paired, never slug alone.
  const rootSlug = sql<string | null>`COALESCE(${txCat.parentSlug}, ${txCat.slug})`;

  const spentRows = await db
    .select({
      userId: transactions.userId,
      rootSlug,
      mtdCents: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(transactions)
    .leftJoin(
      txCat,
      and(eq(txCat.userId, transactions.userId), eq(txCat.slug, transactions.categorySlug)),
    )
    .where(
      and(
        gte(transactions.occurredAt, windowStart),
        lt(transactions.occurredAt, windowEnd),
        notInternalMovement(transactions.channel),
        notAdjustment(transactions.isAdjustment),
        notDeleted(transactions.deletedAt),
      ),
    )
    .groupBy(transactions.userId, rootSlug);

  // Build a lookup: "userId:rootSlug" → mtdCents
  const spentMap = new Map<string, bigint>();
  for (const row of spentRows) {
    if (row.rootSlug !== null) {
      spentMap.set(`${row.userId}:${row.rootSlug}`, BigInt(row.mtdCents));
    }
  }

  // Step 3: Filter to budgets where mtdCents >= amountCents.
  const exceeded: BudgetRow[] = [];
  for (const b of activeBudgets) {
    const mtdCents = spentMap.get(`${b.userId}:${b.categorySlug}`) ?? BigInt(0);
    if (mtdCents >= b.amountCents) {
      exceeded.push({
        userId: b.userId,
        categorySlug: b.categorySlug,
        categoryName: b.categoryName,
        amountCents: b.amountCents,
        mtdCents,
        yearMonth,
      });
    }
  }

  return exceeded;
}

/**
 * Core processor: check every active budget for the current yearMonth and
 * emit `budget_exceeded` notifications for those that are over limit.
 *
 * Dedup is enforced by `emitNotification`'s partial unique index on
 * (user_id, type, entity_id) WHERE read_at IS NULL. The entityId
 * `budget-{slug}-{ym}` ensures at most one unread notification per budget
 * per calendar month — even if the cron fires multiple times.
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function budgetCheckProcessor(job: Job<BudgetCheckJobData>): Promise<void> {
  const yearMonth = getCurrentYearMonth();

  log.info({ event: "budget_check_start", jobId: job.id, yearMonth }, "budget-check started");

  await job.updateProgress({ phase: "fetching", yearMonth });
  await job.log(`start: checking budgets for ${yearMonth}`);

  const exceeded = await fetchExceededBudgets(yearMonth);

  log.info(
    { event: "budget_check_fetched", count: exceeded.length, yearMonth, jobId: job.id },
    `found ${exceeded.length} exceeded budget(s)`,
  );

  let emitted = 0;
  let deduped = 0;

  for (const b of exceeded) {
    const entityId = `budget-${b.categorySlug}-${yearMonth}`;

    try {
      const result = await emitNotification(b.userId, {
        type: "budget_exceeded",
        entityId,
        priority: "medium",
        title: `Pasaste el presupuesto de ${b.categoryName}`,
        body: `Llevás ${formatCop(b.mtdCents)} de ${formatCop(b.amountCents)}.`,
        actionUrl: "/budgets",
        metadata: {
          categorySlug: b.categorySlug,
          yearMonth,
          mtdCents: b.mtdCents.toString(),
          budgetCents: b.amountCents.toString(),
        },
      });

      if (result === null) {
        deduped++;
        log.debug(
          { userId: b.userId, entityId, event: "budget_check_dedup" },
          "budget notification deduped",
        );
      } else {
        emitted++;
        log.info(
          {
            userId: b.userId,
            categorySlug: b.categorySlug,
            yearMonth,
            entityId,
            notificationId: result.id,
            event: "budget_exceeded_emitted",
          },
          "budget_exceeded notification emitted",
        );
      }
    } catch (err) {
      // Per-budget failures are logged but never abort the loop — other users
      // must still get their notifications even if one emit fails.
      log.error(
        {
          err,
          userId: b.userId,
          categorySlug: b.categorySlug,
          entityId,
          event: "budget_check_emit_failed",
        },
        "budget_exceeded emit failed",
      );
    }
  }

  await job.updateProgress({ done: true, exceeded: exceeded.length, emitted, deduped });
  await job.log(
    `done: yearMonth=${yearMonth} exceeded=${exceeded.length} emitted=${emitted} deduped=${deduped}`,
  );

  log.info(
    {
      event: "budget_check_done",
      yearMonth,
      exceeded: exceeded.length,
      emitted,
      deduped,
      jobId: job.id,
    },
    "budget-check complete",
  );
}

/**
 * Create and register the budget-check BullMQ worker.
 *
 * Concurrency 1: the processor iterates all users sequentially. Running
 * multiple concurrent jobs would duplicate notifications (dedup handles
 * it, but wasteful). Single-concurrency is correct here.
 *
 * Retry: 3 attempts with exponential back-off starting at 30s. A missed
 * nightly run is recoverable — the next day's run re-checks.
 */
export function createBudgetCheckWorker() {
  return createWorker<BudgetCheckJobData, void>(
    "budget-check",
    async (job) => {
      try {
        await budgetCheckProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "budget_check_fanout_failed", jobId: job.id },
          "budget-check processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
