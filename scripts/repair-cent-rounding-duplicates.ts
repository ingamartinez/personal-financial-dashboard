/**
 * #1023 — resolve the reconciliation pairs that a cent-rounding near-match left
 * duplicated: a `flagged` tx (SMS/email, rounded to the peso) plus an
 * `imported_from_statement` tx (the bank's exact figure) on the same account.
 * Both were live, so the movement counted twice — in spending and in the
 * account balance.
 *
 * Each pair is resolved through `recordReconciliationDecision({ action:
 * "merged_into" })`: the flagged row survives (it keeps its category,
 * counterparty and notes) and adopts the statement's bank-authoritative fields,
 * and the statement row is soft-deleted. `transfer_group_id` and recurring
 * links are carried so the surviving row stays inside its group, and every
 * touched group is left summing to zero.
 *
 * Usage:
 *   bun scripts/repair-cent-rounding-duplicates.ts --dry-run
 *   bun scripts/repair-cent-rounding-duplicates.ts
 *   bun scripts/repair-cent-rounding-duplicates.ts --user-id=1 --dry-run
 *
 * The identifiers are fixed: this is a one-shot, audited repair for the
 * production rows listed in issue #1023. Every pair is validated before
 * anything is written, and a row outside the enumerated shapes aborts the whole
 * run — a half-applied repair over money is worse than none. Re-running it is
 * not silent: a resolved pair no longer matches the expected state, so the
 * second run aborts instead of writing.
 *
 * Relative imports on purpose — this file is overlaid to $STAGE/scripts/ on
 * prod deploys (see deploy-overlay-must-track-script-imports memory).
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db";
import { transactions } from "../src/lib/db/schema";
import { notDeleted } from "../src/lib/db/helpers";
import { recordReconciliationDecision } from "../src/lib/reconciliation/commit";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "repair-cent-rounding-duplicates" });

export interface CentRoundingPair {
  /** The row that stays: SMS/email captured, rounded to the peso. */
  flaggedTxnId: number;
  /** The statement row: the bank's exact figure. It is retired into the pair. */
  statementTxnId: number;
}

/**
 * The 7 live pairs from issue #1023, verified on prod on 2026-10-26.
 * `flagged` → `statement`, same account, ≤1 COP apart, ≤2 days apart.
 */
export const CENT_ROUNDING_PAIRS: readonly CentRoundingPair[] = [
  { flaggedTxnId: 1459, statementTxnId: 1766 },
  { flaggedTxnId: 1100, statementTxnId: 1817 },
  { flaggedTxnId: 1077, statementTxnId: 1857 },
  { flaggedTxnId: 2107, statementTxnId: 2690 },
  { flaggedTxnId: 2438, statementTxnId: 2789 },
  { flaggedTxnId: 2677, statementTxnId: 2842 },
  { flaggedTxnId: 2678, statementTxnId: 2843 },
];

/** Amount window the engine treats as the same movement (#1023 S1). */
// `BigInt(100)`, not `100n`: the project's tsconfig targets below ES2020 and
// rejects bigint literals (scripts/repair-* follow the same convention).
const ZERO = BigInt(0);
const ROUNDING_TOLERANCE_CENTS = BigInt(100);
/** Statement and capture may land up to two days apart (the issue's evidence). */
const MAX_DATE_DIFF_DAYS = 2;

export interface PairPlan {
  flaggedTxnId: number;
  statementTxnId: number;
  accountId: number;
  action: "merge_into_statement";
  /** statement − flagged, in cents. Positive/negative per the DB sign convention. */
  amountDiffCents: string;
  dateDiffDays: number;
  /** The group the surviving row belongs to, if either leg carried one. */
  transferGroupId: string | null;
  /** True when only the statement leg carried the group, so the survivor takes it. */
  adoptsTransferGroup: boolean;
  /** Group legs the repair must not touch, with the amounts it must preserve. */
  groupOtherLegs: { txnId: number; amountCents: string }[];
  /** Σ over the group's live legs before the repair; adoption must preserve it. */
  groupSumBefore: string | null;
  /** Recurring link handed to the surviving row because it had none. */
  carriedRecurringId: number | null;
}

export interface RepairReport {
  dryRun: boolean;
  userId: number;
  pairs: PairPlan[];
}

const MS_PER_DAY = 86_400_000;

function absBigInt(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

function fail(message: string): never {
  throw new Error(message);
}

function dayDiffDays(a: Date, b: Date): number {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / MS_PER_DAY);
}

type TxRow = {
  id: number;
  userId: number;
  accountId: number;
  occurredAt: Date;
  amountCents: bigint;
  currency: "COP" | "USD";
  reconciliationStatus: "unreconciled" | "matched" | "flagged" | "imported_from_statement";
  statementImportId: number | null;
  transferGroupId: string | null;
  recurringId: number | null;
  deletedAt: Date | null;
};

type GroupLeg = { id: number; amountCents: bigint };

async function loadPairRows(
  userId: number,
  pairs: readonly CentRoundingPair[],
): Promise<Map<number, TxRow>> {
  const ids = pairs.flatMap((p) => [p.flaggedTxnId, p.statementTxnId]);
  const rows = (await db
    .select({
      id: transactions.id,
      userId: transactions.userId,
      accountId: transactions.accountId,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      reconciliationStatus: transactions.reconciliationStatus,
      statementImportId: transactions.statementImportId,
      transferGroupId: transactions.transferGroupId,
      recurringId: transactions.recurringId,
      deletedAt: transactions.deletedAt,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids)))) as TxRow[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) fail(`rounding_repair_rows_missing:${missing.join(",")}`);
  return byId;
}

/** The live legs of a transfer group, used to keep Σ = 0 across the merge. */
async function loadGroupLegs(userId: number, groupId: string): Promise<GroupLeg[]> {
  return db
    .select({ id: transactions.id, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.transferGroupId, groupId),
        notDeleted(transactions.deletedAt),
      ),
    );
}

async function planPair(opts: {
  userId: number;
  pair: CentRoundingPair;
  rows: Map<number, TxRow>;
}): Promise<PairPlan> {
  const { userId, pair, rows } = opts;
  const flagged = rows.get(pair.flaggedTxnId)!;
  const statement = rows.get(pair.statementTxnId)!;
  const where = `flagged=${pair.flaggedTxnId},statement=${pair.statementTxnId}`;

  // --- state every pair must be in before we touch it ----------------------
  if (flagged.deletedAt !== null) fail(`rounding_repair_flagged_deleted:${where}`);
  if (statement.deletedAt !== null) fail(`rounding_repair_statement_deleted:${where}`);
  if (flagged.reconciliationStatus !== "flagged") {
    fail(`rounding_repair_flagged_status:${where}:${flagged.reconciliationStatus}`);
  }
  if (statement.reconciliationStatus !== "imported_from_statement") {
    fail(`rounding_repair_statement_status:${where}:${statement.reconciliationStatus}`);
  }
  if (statement.statementImportId === null) fail(`rounding_repair_statement_not_imported:${where}`);
  if (flagged.accountId !== statement.accountId) fail(`rounding_repair_account_mismatch:${where}`);
  if (flagged.currency !== statement.currency) fail(`rounding_repair_currency_mismatch:${where}`);
  if (flagged.amountCents === ZERO || statement.amountCents === ZERO) {
    fail(`rounding_repair_zero_amount:${where}`);
  }
  if (flagged.amountCents < ZERO !== statement.amountCents < ZERO) {
    fail(`rounding_repair_sign_mismatch:${where}`);
  }

  const amountDiffCents = statement.amountCents - flagged.amountCents;
  if (absBigInt(amountDiffCents) > ROUNDING_TOLERANCE_CENTS) {
    fail(`rounding_repair_amount_out_of_window:${where}:${amountDiffCents}`);
  }
  const dateDiffDays = dayDiffDays(flagged.occurredAt, statement.occurredAt);
  if (dateDiffDays > MAX_DATE_DIFF_DAYS) {
    fail(`rounding_repair_date_out_of_window:${where}:${dateDiffDays}`);
  }

  // --- transfer group: the survivor stays in the group it already belongs to
  //
  // The field reality (checked against the prod snapshot): a real Pago TC group
  // is a cross-currency transfer — savings COP debit plus a TC leg in COP or
  // USD — so "Σ = 0 over the group's legs" is not an invariant of these rows,
  // and inventing a balancing amount would move money the repair has no
  // authority over. What the repair owes the group is integrity: membership
  // unchanged, no leg created or retired, and no leg amount touched except the
  // survivor's own rounding correction.
  const flaggedGroup = flagged.transferGroupId;
  const statementGroup = statement.transferGroupId;
  if (flaggedGroup !== null && statementGroup !== null) {
    // Both legs already claim a group — including the same one, where the pair
    // IS the group. Which leg survives is then an operator decision.
    fail(`rounding_repair_shared_transfer_group:${where}`);
  }
  let group: Pick<
    PairPlan,
    "transferGroupId" | "adoptsTransferGroup" | "groupOtherLegs" | "groupSumBefore"
  > = {
    transferGroupId: null,
    adoptsTransferGroup: false,
    groupOtherLegs: [],
    groupSumBefore: null,
  };
  const groupOwner = flaggedGroup !== null ? flagged : statementGroup !== null ? statement : null;
  const groupId = flaggedGroup ?? statementGroup;
  if (groupOwner !== null && groupId !== null) {
    const legs = await loadGroupLegs(userId, groupId);
    if (!legs.some((l) => l.id === groupOwner.id))
      fail(`rounding_repair_group_leg_missing:${where}`);
    group = {
      transferGroupId: groupId,
      adoptsTransferGroup: groupOwner.id !== flagged.id,
      groupOtherLegs: legs
        .filter((l) => l.id !== groupOwner.id)
        .map((l) => ({ txnId: l.id, amountCents: l.amountCents.toString() })),
      groupSumBefore: legs.reduce((acc, l) => acc + l.amountCents, ZERO).toString(),
    };
  }

  // --- recurring link: carried only when the survivor has none -------------
  let carriedRecurringId: number | null = null;
  if (statement.recurringId !== null) {
    if (flagged.recurringId !== null && flagged.recurringId !== statement.recurringId) {
      fail(`rounding_repair_recurring_link_conflict:${where}`);
    }
    if (flagged.recurringId === null) carriedRecurringId = statement.recurringId;
  }

  return {
    flaggedTxnId: flagged.id,
    statementTxnId: statement.id,
    accountId: flagged.accountId,
    action: "merge_into_statement",
    amountDiffCents: amountDiffCents.toString(),
    dateDiffDays,
    ...group,
    carriedRecurringId,
  };
}

async function applyPair(userId: number, plan: PairPlan): Promise<void> {
  // Carry the group and the recurring link onto the surviving row BEFORE the
  // merge: `recordReconciliationDecision` copies the statement's money fields
  // but neither of these, and the statement row is soft-deleted right after.
  if (plan.adoptsTransferGroup && plan.transferGroupId !== null) {
    await db
      .update(transactions)
      .set({ transferGroupId: plan.transferGroupId, updatedAt: new Date() })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, plan.flaggedTxnId)));
  }
  if (plan.carriedRecurringId !== null) {
    await db
      .update(transactions)
      .set({ recurringId: plan.carriedRecurringId, updatedAt: new Date() })
      .where(and(eq(transactions.userId, userId), eq(transactions.id, plan.flaggedTxnId)));
  }

  await recordReconciliationDecision({
    userId,
    txnId: plan.flaggedTxnId,
    action: "merged_into",
    mergedIntoTxnId: plan.statementTxnId,
    note: `#1023 cent-rounding duplicate (Δ ${plan.amountDiffCents} cents, ${plan.dateDiffDays}d)`,
  });
}

/** Refuses to report success on a pair the merge did not actually resolve. */
async function verifyPair(userId: number, plan: PairPlan): Promise<void> {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      reconciliationStatus: transactions.reconciliationStatus,
      statementImportId: transactions.statementImportId,
      transferGroupId: transactions.transferGroupId,
      recurringId: transactions.recurringId,
      deletedAt: transactions.deletedAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.id, [plan.flaggedTxnId, plan.statementTxnId]),
      ),
    );

  const survivor = rows.find((r) => r.id === plan.flaggedTxnId);
  const retired = rows.find((r) => r.id === plan.statementTxnId);
  if (!survivor || !retired) fail(`rounding_repair_verify_missing:${plan.flaggedTxnId}`);
  if (survivor.reconciliationStatus !== "matched") {
    fail(`rounding_repair_verify_survivor_status:${plan.flaggedTxnId}`);
  }
  if (survivor.deletedAt !== null)
    fail(`rounding_repair_verify_survivor_deleted:${plan.flaggedTxnId}`);
  if (retired.deletedAt === null)
    fail(`rounding_repair_verify_statement_live:${plan.statementTxnId}`);
  if (plan.transferGroupId !== null && survivor.transferGroupId !== plan.transferGroupId) {
    fail(`rounding_repair_verify_group_not_carried:${plan.flaggedTxnId}`);
  }
  if (plan.carriedRecurringId !== null && survivor.recurringId !== plan.carriedRecurringId) {
    fail(`rounding_repair_verify_recurring_not_carried:${plan.flaggedTxnId}`);
  }

  if (plan.transferGroupId !== null) {
    const legs = await loadGroupLegs(userId, plan.transferGroupId);
    const memberIds = legs.map((l) => l.id).sort((a, b) => a - b);
    const expectedIds = [plan.flaggedTxnId, ...plan.groupOtherLegs.map((l) => l.txnId)].sort(
      (a, b) => a - b,
    );
    if (memberIds.join(",") !== expectedIds.join(",")) {
      fail(
        `rounding_repair_verify_group_membership:${plan.transferGroupId}:${memberIds.join(",")}`,
      );
    }
    // No leg the repair did not own may have moved, by so much as a cent.
    for (const leg of plan.groupOtherLegs) {
      const found = legs.find((l) => l.id === leg.txnId);
      if (!found || found.amountCents.toString() !== leg.amountCents) {
        fail(`rounding_repair_verify_group_leg_changed:${leg.txnId}`);
      }
    }
    // Adoption moves membership from the statement leg to the survivor, which
    // carries the same amount, so the group's sum must come out identical.
    if (plan.adoptsTransferGroup) {
      const sumAfter = legs.reduce((acc, l) => acc + l.amountCents, ZERO).toString();
      if (sumAfter !== plan.groupSumBefore) {
        fail(`rounding_repair_verify_group_sum_changed:${plan.transferGroupId}:${sumAfter}`);
      }
    }
  }
}

/**
 * Validates every pair first (so a bad row aborts before any write), then —
 * unless `dryRun` — resolves them one by one and verifies each result.
 */
export async function repairCentRoundingDuplicates(opts: {
  dryRun: boolean;
  userId?: number;
  pairs?: readonly CentRoundingPair[];
}): Promise<RepairReport> {
  const userId = opts.userId ?? 1;
  const pairs = opts.pairs ?? CENT_ROUNDING_PAIRS;

  const rows = await loadPairRows(userId, pairs);
  // Plan up front: the first unexpected row throws and nothing has been written.
  const plans: PairPlan[] = [];
  for (const pair of pairs) {
    plans.push(await planPair({ userId, pair, rows }));
  }

  if (!opts.dryRun) {
    for (const plan of plans) {
      await applyPair(userId, plan);
      await verifyPair(userId, plan);
    }
  }

  return { dryRun: opts.dryRun, userId, pairs: plans };
}

function parseArgs(argv: string[]): { dryRun: boolean; userId: number } {
  let dryRun = false;
  let userId = 1;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const match = arg.match(/^--user-id=(\d+)$/);
    if (match) {
      userId = Number(match[1]);
      continue;
    }
    log.error({ arg, event: "rounding_repair_unknown_arg" }, "unknown argument");
    process.exit(1);
  }
  return { dryRun, userId };
}

if (import.meta.main) {
  const { dryRun, userId } = parseArgs(process.argv.slice(2));
  repairCentRoundingDuplicates({ dryRun, userId })
    .then(async (report) => {
      for (const pair of report.pairs) {
        log.info(
          {
            event: "rounding_repair_pair",
            ...pair,
          },
          `pair ${pair.flaggedTxnId}<-${pair.statementTxnId}`,
        );
      }
      log.info(
        {
          dryRun: report.dryRun,
          userId: report.userId,
          pairs: report.pairs.length,
          event: "rounding_repair_done",
        },
        dryRun
          ? `dry run — ${report.pairs.length} pairs, no writes`
          : `${report.pairs.length} pairs resolved`,
      );
      await db.$client.end({ timeout: 1 });
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      log.error({ err, event: "rounding_repair_failed" }, "cent-rounding repair failed");
      await db.$client.end({ timeout: 1 }).catch(() => void 0);
      process.exit(1);
    });
}
