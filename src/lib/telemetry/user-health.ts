import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  ingestionLogs,
  statementImports,
  transactions,
  userHealthSnapshots,
  users,
  type CaptureSources30d,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";

const MS_PER_DAY = 86_400_000;
const THIRTY_DAYS_MS = 30 * MS_PER_DAY;
const SEVEN_DAYS_MS = 7 * MS_PER_DAY;
const FOURTEEN_DAYS_MS = 14 * MS_PER_DAY;

export type UserHealthSnapshotData = {
  lastSmsReceivedAt: Date | null;
  lastCaptureAt: Date | null;
  captureSources30d: CaptureSources30d;
  // Null when the user had zero ingest attempts in the 30d window — we surface
  // that as "no signal" in the UI rather than 0% or 100%.
  parserSuccessRate30d: number | null;
  unreconciledTxnCount: number;
  divergenceCents: bigint | null;
  statementDivergenceCents: bigint | null;
  churnSignalFlag: boolean;
};

export async function computeUserHealthSnapshot(
  userId: number,
  now: Date = new Date(),
): Promise<UserHealthSnapshotData> {
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);

  const [smsRow] = await db
    .select({ last: sql<string | null>`max(${ingestionLogs.startedAt})` })
    .from(ingestionLogs)
    .where(and(eq(ingestionLogs.userId, userId), eq(ingestionLogs.source, "sms")));

  const [captureRow] = await db
    .select({
      first: sql<string | null>`min(${transactions.createdAt})`,
      last: sql<string | null>`max(${transactions.createdAt})`,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId));

  const sourceRows = await db
    .select({
      source: transactions.source,
      count: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), gte(transactions.createdAt, thirtyDaysAgo)))
    .groupBy(transactions.source);

  const captureSources30d: CaptureSources30d = {};
  for (const row of sourceRows) {
    captureSources30d[row.source] = row.count;
  }

  // Exclude AI-classify jobs (pipeline.ts re-classifies existing rows, it's
  // not a new ingest) and debug endpoint hits (test traffic, not real user
  // capture). Both are disambiguated via `payload.kind`.
  const [parserRow] = await db
    .select({
      success: sql<number>`count(*) FILTER (WHERE ${ingestionLogs.status} IN ('inserted', 'duplicated'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(ingestionLogs)
    .where(
      and(
        eq(ingestionLogs.userId, userId),
        gte(ingestionLogs.startedAt, thirtyDaysAgo),
        sql`(${ingestionLogs.payload} ->> 'kind') NOT IN ('ai-classify', 'debug-capture') OR (${ingestionLogs.payload} ->> 'kind') IS NULL`,
      ),
    );

  const parserSuccessRate30d = parserRow.total === 0 ? null : parserRow.success / parserRow.total;

  const lastCaptureAt = captureRow.last ? new Date(captureRow.last) : null;
  const firstCaptureAt = captureRow.first ? new Date(captureRow.first) : null;

  const churnSignalFlag =
    lastCaptureAt !== null &&
    firstCaptureAt !== null &&
    now.getTime() - lastCaptureAt.getTime() > SEVEN_DAYS_MS &&
    now.getTime() - firstCaptureAt.getTime() > FOURTEEN_DAYS_MS;

  const [unreconciledRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.channel, "bank"),
        eq(transactions.isAdjustment, false),
        eq(transactions.reconciliationStatus, "unreconciled"),
      ),
    );

  const [divergenceRow] = await db
    .select({
      count: sql<number>`count(*)::int`,
      sum: sql<string | null>`sum(${transactions.amountCents})::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.isAdjustment, true),
        gte(transactions.occurredAt, thirtyDaysAgo),
      ),
    );

  const divergenceCents =
    divergenceRow.count === 0 || divergenceRow.sum === null ? null : BigInt(divergenceRow.sum);

  const statementDivergenceCents = await computeStatementDivergence(userId, thirtyDaysAgo);

  return {
    lastSmsReceivedAt: smsRow.last ? new Date(smsRow.last) : null,
    lastCaptureAt,
    captureSources30d,
    parserSuccessRate30d,
    unreconciledTxnCount: unreconciledRow.count,
    divergenceCents,
    statementDivergenceCents,
    churnSignalFlag,
  };
}

/**
 * For each account with a statement import in the last 30 days that carries
 * a user-provided balance, compares findash's stored balance against the
 * most recent statement balance and sums the signed deltas. Null when no
 * account has a qualifying statement — the column stays blank rather than
 * showing a misleading zero.
 */
async function computeStatementDivergence(
  userId: number,
  thirtyDaysAgo: Date,
): Promise<bigint | null> {
  const windowStart = thirtyDaysAgo.toISOString().slice(0, 10);
  const imports = await db
    .select({
      accountId: statementImports.accountId,
      balanceAtEndCents: statementImports.balanceAtEndCents,
    })
    .from(statementImports)
    .where(
      and(
        eq(statementImports.userId, userId),
        gte(statementImports.periodEnd, windowStart),
        isNotNull(statementImports.balanceAtEndCents),
      ),
    )
    .orderBy(desc(statementImports.periodEnd));

  const latestPerAccount = new Map<number, bigint>();
  for (const imp of imports) {
    if (imp.balanceAtEndCents === null) continue;
    if (!latestPerAccount.has(imp.accountId)) {
      latestPerAccount.set(imp.accountId, imp.balanceAtEndCents);
    }
  }
  if (latestPerAccount.size === 0) return null;

  const accountRows = await db
    .select({ id: accounts.id, balanceCents: derivedBalanceCentsSql })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)));

  let total = BigInt(0);
  for (const acc of accountRows) {
    const stmtBalance = latestPerAccount.get(acc.id);
    if (stmtBalance !== undefined) {
      total += BigInt(acc.balanceCents) - stmtBalance;
    }
  }
  return total;
}

export async function saveUserHealthSnapshot(
  userId: number,
  data: UserHealthSnapshotData,
  capturedAt: Date = new Date(),
): Promise<void> {
  await db.insert(userHealthSnapshots).values({
    userId,
    capturedAt,
    lastSmsReceivedAt: data.lastSmsReceivedAt,
    lastCaptureAt: data.lastCaptureAt,
    captureSources30d: data.captureSources30d,
    parserSuccessRate30d:
      data.parserSuccessRate30d === null ? null : data.parserSuccessRate30d.toFixed(4),
    unreconciledTxnCount: data.unreconciledTxnCount,
    divergenceCents: data.divergenceCents,
    statementDivergenceCents: data.statementDivergenceCents,
    churnSignalFlag: data.churnSignalFlag,
  });
}

export type SnapshotFanoutEntry =
  | { userId: number; ok: true; data: UserHealthSnapshotData }
  | { userId: number; ok: false; error: string };

export async function snapshotAllActiveUsers(
  now: Date = new Date(),
): Promise<SnapshotFanoutEntry[]> {
  const activeUsers = await db.select({ id: users.id }).from(users).where(eq(users.active, true));

  const results: SnapshotFanoutEntry[] = [];
  for (const { id } of activeUsers) {
    try {
      const data = await computeUserHealthSnapshot(id, now);
      await saveUserHealthSnapshot(id, data, now);
      results.push({ userId: id, ok: true, data });
    } catch (err) {
      results.push({
        userId: id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
