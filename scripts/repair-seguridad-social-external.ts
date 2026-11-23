/**
 * #1034 — mark an occurrence as paid from an account findash does not track.
 *
 * Production shape (issue #1030/#1034): "Seguridad Social Aida" (#9) and
 * "Seguridad Social Alejo" (#10) are paid every month from an account the user
 * deliberately does not track, so there will never be a transaction row and the
 * app reported a gap + notification for a payment that was made. This one-shot,
 * audited repair marks the November 2026 slot of both recurrings as
 * 'paid-external' (recurring_gaps.resolution) and invents nothing: no
 * transaction is created and resolution_tx_id stays NULL.
 *
 * Usage:
 *   bun scripts/repair-seguridad-social-external.ts --dry-run
 *   bun scripts/repair-seguridad-social-external.ts
 *
 * The identifiers are intentionally fixed. The script REFUSES to write when a
 * slot is not in the expected shape — a recurring that is missing, archived or
 * inactive, a transaction already linked for that month (which would mean the
 * occurrence was actually matched), or a gap resolved some other way. Re-running
 * it is a no-op: a slot already marked paid-external is reported as such and
 * skipped.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  GAP_RESOLUTION_PAID_EXTERNAL,
  recurringGaps,
  recurringTransactions,
  transactions,
} from "../src/lib/db/schema";
import { notDeleted } from "../src/lib/db/helpers";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "repair-seguridad-social-external" });

const USER_ID = 1;
const TARGET_YEAR_MONTH = "2026-11";
const RECURRING_IDS = [9, 10];

type PlanEntry = {
  recurringId: number;
  label: string;
  yearMonth: string;
  action: "mark" | "already-marked";
};

type Refusal = {
  recurringId: number;
  reason: string;
};

function parseDryRun(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--dry-run") continue;
    log.error({ arg, event: "repair_paid_external_unknown_arg" }, "unknown argument");
    process.exit(1);
  }
  return argv.includes("--dry-run");
}

/**
 * Read-only: validates every fixed id and produces the write plan. Anything
 * outside the enumerated expected shape becomes a refusal and aborts the run
 * before a single write.
 */
async function buildPlan(): Promise<{ plan: PlanEntry[]; refusals: Refusal[] }> {
  const plan: PlanEntry[] = [];
  const refusals: Refusal[] = [];

  const recurrings = await db
    .select({
      id: recurringTransactions.id,
      label: recurringTransactions.label,
      active: recurringTransactions.active,
      deletedAt: recurringTransactions.deletedAt,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, USER_ID),
        inArray(recurringTransactions.id, RECURRING_IDS),
      ),
    );

  for (const recurringId of RECURRING_IDS) {
    const recurring = recurrings.find((row) => row.id === recurringId);
    if (!recurring) {
      refusals.push({ recurringId, reason: "recurring not found for this user" });
      continue;
    }
    if (recurring.deletedAt !== null) {
      refusals.push({ recurringId, reason: "recurring is archived" });
      continue;
    }
    if (!recurring.active) {
      refusals.push({ recurringId, reason: "recurring is inactive" });
      continue;
    }

    const linked = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, USER_ID),
          eq(transactions.recurringId, recurringId),
          eq(transactions.recurringYearMonth, TARGET_YEAR_MONTH),
          notDeleted(transactions.deletedAt),
        ),
      )
      .limit(1);
    if (linked.length > 0) {
      refusals.push({
        recurringId,
        reason: `a transaction is already linked for ${TARGET_YEAR_MONTH} (tx #${linked[0]!.id})`,
      });
      continue;
    }

    const [gap] = await db
      .select({ resolution: recurringGaps.resolution })
      .from(recurringGaps)
      .where(
        and(
          eq(recurringGaps.userId, USER_ID),
          eq(recurringGaps.recurringId, recurringId),
          eq(recurringGaps.yearMonth, TARGET_YEAR_MONTH),
        ),
      )
      .limit(1);

    if (gap && gap.resolution !== null && gap.resolution !== GAP_RESOLUTION_PAID_EXTERNAL) {
      refusals.push({
        recurringId,
        reason: `gap already resolved as '${gap.resolution}'`,
      });
      continue;
    }

    plan.push({
      recurringId,
      label: recurring.label,
      yearMonth: TARGET_YEAR_MONTH,
      action: gap?.resolution === GAP_RESOLUTION_PAID_EXTERNAL ? "already-marked" : "mark",
    });
  }

  return { plan, refusals };
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));
  const { plan, refusals } = await buildPlan();

  if (refusals.length > 0) {
    log.error(
      {
        event: "repair_paid_external_refused",
        userId: USER_ID,
        yearMonth: TARGET_YEAR_MONTH,
        refusals,
      },
      "refusing to mark paid-external: unexpected state",
    );
    process.exit(1);
  }

  log.info(
    {
      dryRun,
      event: "repair_paid_external_plan",
      userId: USER_ID,
      yearMonth: TARGET_YEAR_MONTH,
      plan,
    },
    dryRun ? "dry run — no writes" : "applying paid-external marks",
  );
  if (dryRun) return;

  await db.transaction(async (trx) => {
    for (const entry of plan) {
      if (entry.action === "already-marked") continue;

      // Same slot the UI toggle writes: resolution set, resolvedAt stamped,
      // resolution_tx_id NULL because there is no transaction behind it.
      await trx
        .insert(recurringGaps)
        .values({
          userId: USER_ID,
          recurringId: entry.recurringId,
          yearMonth: entry.yearMonth,
          resolution: GAP_RESOLUTION_PAID_EXTERNAL,
          resolvedAt: new Date(),
          resolutionTxId: null,
        })
        .onConflictDoUpdate({
          target: [recurringGaps.recurringId, recurringGaps.yearMonth],
          set: {
            resolution: GAP_RESOLUTION_PAID_EXTERNAL,
            resolvedAt: new Date(),
            resolutionTxId: null,
          },
        });
    }
  });

  log.info(
    {
      event: "repair_paid_external_done",
      userId: USER_ID,
      yearMonth: TARGET_YEAR_MONTH,
      marked: plan.filter((entry) => entry.action === "mark").length,
      alreadyMarked: plan.filter((entry) => entry.action === "already-marked").length,
    },
    "paid-external marks complete",
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    log.error({ err, event: "repair_paid_external_failed" }, "paid-external repair failed");
    process.exit(1);
  });
}
