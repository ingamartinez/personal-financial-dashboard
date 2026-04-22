import { createHash } from "node:crypto";

import { and, eq, gte, lte, sql } from "drizzle-orm";

import { db, type DB } from "@/lib/db";
import { accounts, statementImports, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { applyInteresesCausadosForCycle } from "@/lib/finance/intereses-causados-job";
import { createLogger } from "@/lib/logger";

import {
  isBankInterestRow,
  matchStatementAgainstLedger,
  statementAmountToLedger,
  type MatchResult,
  type TxRowForMatch,
} from "./match";
import type { ParsedStatement, StatementRow } from "./types";

const log = createLogger({ module: "bancolombia-statement-consolidate" });

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CYCLE_REGEX = /^\d{4}-\d{2}$/;

export type ConsolidationStatus = "dry-run" | "consolidated" | "already-consolidated" | "no-op";

export type InteresesOutcome =
  | {
      status: "inserted";
      txId: number;
      totalInterestCentsStr: string;
      purchasesNeedingRate: number;
    }
  | { status: "skipped"; reason: string; purchasesNeedingRate: number }
  | { status: "not-run"; reason: "dry-run" | "already-consolidated" };

export type MatchStats = {
  matched: number;
  matchedWillChange: number;
  insertedMissing: number;
  skippedMissingBefore: number;
  unmatchedInLedger: number;
};

export type ConsolidationReport = {
  userId: number;
  accountId: number;
  // Account currency — useful to callers rendering multi-sheet previews so they
  // can label each report section (COP vs USD) without re-querying the account.
  currency: "COP" | "USD";
  cycle: string;
  dryRun: boolean;
  status: ConsolidationStatus;
  matchStats: MatchStats;
  matchedTxIds: number[];
  insertedTxIds: number[];
  // Row-level diffs for UI preview (B3). Serialized bigints as strings.
  matchedDiffs: Array<{
    txId: number;
    willChange: boolean;
    merchant: string;
    occurredAt: string;
    amountCentsStr: string;
    installmentsTotalBefore: number;
    installmentsTotalAfter: number;
    rateEmX10kBefore: number | null;
    rateEmX10kAfter: number | null;
  }>;
  missingInLedger: Array<{
    merchant: string;
    occurredAt: string;
    amountCentsStr: string;
    kind: "during-period" | "before-period";
    authorizationNumber: string | null;
  }>;
  unmatchedInLedgerIds: number[];
  statementImportId: number | null;
  intereses: InteresesOutcome;
};

export type ConsolidateOptions = {
  userId: number;
  accountId: number;
  cycle: string;
  parsed: ParsedStatement;
  fileHash: string;
  dryRun: boolean;
  database?: DB;
};

export function hashStatementBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function externalIdFor(accountId: number, cycle: string, authCode: string): string {
  return `bancolombia-stmt:${accountId}:${cycle}:${authCode}`;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, delta: number): Date {
  return new Date(d.getTime() + delta * MS_PER_DAY);
}

function minRowDate(parsed: ParsedStatement): Date | null {
  if (parsed.rows.length === 0) return null;
  let min = parsed.rows[0].occurredAt;
  for (const row of parsed.rows) {
    if (row.occurredAt.getTime() < min.getTime()) min = row.occurredAt;
  }
  return min;
}

async function loadAccount(
  database: DB,
  userId: number,
  accountId: number,
): Promise<{ id: number; currency: "COP" | "USD" }> {
  const [row] = await database
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `consolidateCycleFromStatement: account ${accountId} not found for user ${userId}`,
    );
  }
  return row;
}

async function loadExistingTxs(
  database: DB,
  userId: number,
  accountId: number,
  fromDate: Date,
  toDate: Date,
): Promise<TxRowForMatch[]> {
  const rows = await database
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
      installmentsTotal: transactions.installmentsTotal,
      installmentRateEmX10k: transactions.installmentRateEmX10k,
      externalId: transactions.externalId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        gte(transactions.occurredAt, fromDate),
        lte(transactions.occurredAt, toDate),
        notDeleted(transactions.deletedAt),
      ),
    );
  return rows;
}

function buildMatchStats(match: MatchResult): MatchStats {
  const matchedWillChange = match.matched.filter((m) => m.willChange).length;
  const insertedMissing = match.missingInLedger.filter((r) => r.kind === "during-period").length;
  const skippedMissingBefore = match.missingInLedger.filter(
    (r) => r.kind === "before-period",
  ).length;
  return {
    matched: match.matched.length,
    matchedWillChange,
    insertedMissing,
    skippedMissingBefore,
    unmatchedInLedger: match.unmatchedInLedger.length,
  };
}

function serializeMatchedDiffs(match: MatchResult): ConsolidationReport["matchedDiffs"] {
  return match.matched.map((m) => ({
    txId: m.txId,
    willChange: m.willChange,
    merchant: m.statementRow.merchant,
    occurredAt: m.statementRow.occurredAt.toISOString(),
    amountCentsStr: m.statementRow.amountCents.toString(),
    installmentsTotalBefore: m.diff.installmentsTotalBefore,
    installmentsTotalAfter: m.diff.installmentsTotalAfter,
    rateEmX10kBefore: m.diff.rateEmX10kBefore,
    rateEmX10kAfter: m.diff.rateEmX10kAfter,
  }));
}

function serializeMissing(match: MatchResult): ConsolidationReport["missingInLedger"] {
  return match.missingInLedger.map((r) => ({
    merchant: r.merchant,
    occurredAt: r.occurredAt.toISOString(),
    amountCentsStr: r.amountCents.toString(),
    kind: r.kind,
    authorizationNumber: r.authorizationNumber,
  }));
}

function emptyReport(
  opts: ConsolidateOptions,
  account: { id: number; currency: "COP" | "USD" },
  match: MatchResult,
  status: ConsolidationStatus,
  statementImportId: number | null,
  intereses: InteresesOutcome,
): ConsolidationReport {
  return {
    userId: opts.userId,
    accountId: opts.accountId,
    currency: account.currency,
    cycle: opts.cycle,
    dryRun: opts.dryRun,
    status,
    matchStats: buildMatchStats(match),
    matchedTxIds: match.matched.map((m) => m.txId),
    insertedTxIds: [],
    matchedDiffs: serializeMatchedDiffs(match),
    missingInLedger: serializeMissing(match),
    unmatchedInLedgerIds: match.unmatchedInLedger.map((t) => t.id),
    statementImportId,
    intereses,
  };
}

export async function consolidateCycleFromStatement(
  opts: ConsolidateOptions,
): Promise<ConsolidationReport> {
  if (!CYCLE_REGEX.test(opts.cycle)) {
    throw new Error(`consolidateCycleFromStatement: cycle must be YYYY-MM, got "${opts.cycle}"`);
  }
  const database = opts.database ?? db;
  const account = await loadAccount(database, opts.userId, opts.accountId);

  // Short-circuit if this cycle is already consolidated. Return the persisted
  // report so callers can display past runs without re-work.
  const [existing] = await database
    .select({
      id: statementImports.id,
      report: statementImports.report,
      syntheticTxId: statementImports.syntheticTxId,
    })
    .from(statementImports)
    .where(
      and(
        eq(statementImports.userId, opts.userId),
        eq(statementImports.accountId, opts.accountId),
        eq(statementImports.kind, "extracto_detallado"),
        eq(statementImports.cycle, opts.cycle),
      ),
    )
    .limit(1);
  if (existing) {
    const persistedReport = (existing.report ?? {}) as Partial<ConsolidationReport>;
    return {
      ...(persistedReport as ConsolidationReport),
      // Persisted reports written before the currency field was added may
      // lack it — fill from the current account so the UI has what it needs.
      currency: persistedReport.currency ?? account.currency,
      dryRun: opts.dryRun,
      status: "already-consolidated",
      statementImportId: existing.id,
      intereses: {
        status: "not-run",
        reason: "already-consolidated",
      },
    };
  }

  const earliest = minRowDate(opts.parsed);
  const fromDate = earliest ? addDays(earliest, -2) : addDays(opts.parsed.period.startDate, -2);
  const toDate = addDays(opts.parsed.period.endDate, 2);
  const txs = await loadExistingTxs(database, opts.userId, opts.accountId, fromDate, toDate);
  const match = matchStatementAgainstLedger(opts.parsed, txs);

  if (opts.dryRun) {
    return emptyReport(opts, account, match, "dry-run", null, {
      status: "not-run",
      reason: "dry-run",
    });
  }

  const nothingToDo =
    match.matched.every((m) => !m.willChange) &&
    match.missingInLedger.every((r) => r.kind !== "during-period");
  if (nothingToDo) {
    // Still persist a statement_imports row so the cycle is marked "seen" —
    // but we skip the intereses run because nothing changed ledger-side, and
    // we return "no-op" so callers can distinguish "applied" vs "nothing to
    // apply". The intereses-causados-job is still idempotent on its own
    // cycleKey check if called later.
    //
    // Run the intereses job anyway so the first-ever consolidation of a
    // cycle produces the synthetic; the job is a no-op when the synthetic
    // already exists (cycleKey idempotency).
  }

  // Part 1: ledger UPDATEs + INSERTs + statement_imports row in a single
  // transaction. applyInteresesCausadosForCycle runs AFTER commit — it owns
  // its own idempotency (cycleKey) so a second run is a no-op, and keeping it
  // outside this tx avoids the drizzle DB-vs-Transaction type mismatch and
  // makes partial-failure semantics sane (ledger fix commits even if the
  // intereses job fails; user can retry).
  const { imp, matchedIdsToUpdate, insertedTxIds } = await database.transaction(async (txDb) => {
    const [imp] = await txDb
      .insert(statementImports)
      .values({
        userId: opts.userId,
        accountId: opts.accountId,
        fileHash: opts.fileHash,
        periodStart: toIsoDate(opts.parsed.period.startDate),
        periodEnd: toIsoDate(opts.parsed.period.endDate),
        txnCount: 0,
        kind: "extracto_detallado",
        cycle: opts.cycle,
        report: null,
      })
      .returning({ id: statementImports.id });

    const matchedIdsToUpdate: number[] = [];
    for (const m of match.matched) {
      if (!m.willChange) continue;
      await txDb
        .update(transactions)
        .set({
          installmentsTotal: m.diff.installmentsTotalAfter,
          ...(m.diff.rateEmX10kAfter !== null && {
            installmentRateEmX10k: m.diff.rateEmX10kAfter,
          }),
          reconciliationStatus: "matched",
          reconciledAt: new Date(),
          statementImportId: imp.id,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.id, m.txId), eq(transactions.userId, opts.userId)));
      matchedIdsToUpdate.push(m.txId);
    }

    const insertedTxIds: number[] = [];
    for (const row of match.missingInLedger) {
      if (row.kind !== "during-period") continue;
      if (isBankInterestRow(row)) continue;
      if (row.authorizationNumber === null) {
        log.warn(
          {
            accountId: opts.accountId,
            cycle: opts.cycle,
            merchant: row.merchant,
            event: "missing_auth_skip",
          },
          "consolidate: skipping missing row without authorizationNumber",
        );
        continue;
      }
      const inserted = await insertMissingRowInTx(txDb, {
        opts,
        account,
        row,
        statementImportId: imp.id,
      });
      if (inserted !== null) insertedTxIds.push(inserted);
    }

    await txDb
      .update(statementImports)
      .set({ txnCount: matchedIdsToUpdate.length + insertedTxIds.length })
      .where(eq(statementImports.id, imp.id));

    return { imp, matchedIdsToUpdate, insertedTxIds };
  });

  const interesesResult = await applyInteresesCausadosForCycle({
    userId: opts.userId,
    accountId: opts.accountId,
    cycle: opts.cycle,
    database,
  });
  const intereses: InteresesOutcome = interesesToOutcome(interesesResult);

  const finalReport: ConsolidationReport = {
    userId: opts.userId,
    accountId: opts.accountId,
    currency: account.currency,
    cycle: opts.cycle,
    dryRun: false,
    status: "consolidated",
    matchStats: buildMatchStats(match),
    matchedTxIds: matchedIdsToUpdate,
    insertedTxIds,
    matchedDiffs: serializeMatchedDiffs(match),
    missingInLedger: serializeMissing(match),
    unmatchedInLedgerIds: match.unmatchedInLedger.map((t) => t.id),
    statementImportId: imp.id,
    intereses,
  };

  await database
    .update(statementImports)
    .set({
      report: finalReport,
      ...(intereses.status === "inserted" && { syntheticTxId: intereses.txId }),
    })
    .where(eq(statementImports.id, imp.id));

  return finalReport;
}

type InsertMissingArgs = {
  opts: ConsolidateOptions;
  account: { id: number; currency: "COP" | "USD" };
  row: StatementRow;
  statementImportId: number;
};

// Named *InTx because it must run inside a transaction handle — caller passes
// the drizzle tx object, not the top-level db.
async function insertMissingRowInTx(
  txDb: Parameters<Parameters<DB["transaction"]>[0]>[0],
  { opts, account, row, statementImportId }: InsertMissingArgs,
): Promise<number | null> {
  const external = externalIdFor(opts.accountId, opts.cycle, row.authorizationNumber!);
  const result = await txDb
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: account.id,
      occurredAt: row.occurredAt,
      // statement row uses extracto sign convention (compra+, abono-) while
      // the ledger stores the opposite — invert on the way in.
      amountCents: statementAmountToLedger(row.amountCents),
      currency: account.currency,
      descriptionRaw: row.merchant,
      merchant: row.merchant,
      installmentsTotal: row.installments?.total ?? 1,
      installmentRateEmX10k: row.rateEmX10k,
      source: "csv_reconcile",
      channel: "bank",
      reconciliationStatus: "imported_from_statement",
      reconciledAt: new Date(),
      statementImportId,
      externalId: external,
      rawData: {
        statementKind: "extracto_detallado",
        cycle: opts.cycle,
        authorizationNumber: row.authorizationNumber,
        saldoPendingCents: row.saldoPendingCents.toString(),
        installmentValueCents: row.installmentValueCents?.toString() ?? null,
      },
    })
    .onConflictDoNothing({
      target: [transactions.accountId, transactions.externalId],
      where: sql`${transactions.externalId} IS NOT NULL`,
    })
    .returning({ id: transactions.id });
  return result[0]?.id ?? null;
}

function interesesToOutcome(
  r: Awaited<ReturnType<typeof applyInteresesCausadosForCycle>>,
): InteresesOutcome {
  if (r.status === "inserted") {
    return {
      status: "inserted",
      txId: r.txId,
      totalInterestCentsStr: r.totalInterestCents.toString(),
      purchasesNeedingRate: r.purchasesNeedingRate,
    };
  }
  if (r.status === "skipped") {
    return {
      status: "skipped",
      reason: r.reason,
      purchasesNeedingRate: r.purchasesNeedingRate,
    };
  }
  return {
    status: "skipped",
    reason: `error:${r.reason}`,
    purchasesNeedingRate: 0,
  };
}
