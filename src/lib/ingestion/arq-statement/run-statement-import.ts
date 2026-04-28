// ARQ statement import orchestrator.
//
// Wraps: PDF buffer → parse → reconcile → chain check → persist arq_statement_imports
//        → cross-channel dedup via reconcileEmailVsStatement (#517).
//
// Idempotency: if the same PDF hash was already imported for this user, the
// function returns early with the existing import row. Callers can force a
// re-parse by deleting the arq_statement_imports row first.
//
// Tenant safety:
//   - All queries filter by BOTH user_id AND account_id (memory: per-user-table-join-tenant-safety).
//   - Account ownership is validated up-front: if the provided account_id does
//     not belong to user_id the function rejects with an error before parsing.
//   - Never rely on account_id alone when querying arq_statement_imports.

import { and, desc, eq, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accountSnapshots, accounts, arqStatementImports } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

import { buildChainCheck, reconcileStatement } from "./balance";
import type { ChainCheck, ReconcileResult } from "./balance";
import { reconcileEmailVsStatement } from "./reconciler";
import type { ReconcilerDeps } from "./reconciler";
import { parseStatementTransactions } from "./type-handlers";
import type { ParsedStatementTx } from "./type-handlers";
import type { RawStatement } from "./types";

export type { ChainCheck, ReconcileResult };

const log = createLogger({ module: "arq-statement-run-import" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatementImportPreview {
  reconcile: ReconcileResult;
  chainCheck: ChainCheck;
  parsedTxs: ParsedStatementTx[];
}

export type RunStatementImportResult =
  | { status: "already_imported"; importId: number }
  | {
      status: "reconcile_failed";
      preview: StatementImportPreview;
      importId: number;
    }
  | {
      status: "committed";
      importId: number;
      preview: StatementImportPreview;
      /** Tx rows newly inserted (statement-only events with no email counterpart). */
      insertedTxCount: number;
      /** IDs of the newly inserted transaction rows (parallel to insertedTxCount). */
      insertedTxIds: number[];
      /** Existing gmail_arq rows updated with statement metadata. */
      mergedTxCount: number;
      /** Rows flagged source_mismatch (diverged merges + email orphans). */
      flaggedTxCount: number;
      /** gmail_arq txs in the period that had no statement counterpart. */
      emailOrphanCount: number;
    }
  | { status: "error"; error: string };

// ---------------------------------------------------------------------------
// Deps injection (for testability without mocking module globals)
// ---------------------------------------------------------------------------

export interface RunStatementImportDeps {
  /**
   * Parse a PDF buffer into a RawStatement.
   * Injected so callers can swap in a fake adapter in tests.
   */
  parsePdf: (buffer: Buffer) => Promise<RawStatement>;
  /**
   * Reconciler dependencies (primarily the db handle). Injected so tests can
   * stub the reconciler without mocking module globals.
   * Defaults to `{}` which uses the global db.
   */
  reconcilerDeps?: ReconcilerDeps;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full pipeline for a single ARQ statement PDF:
 *   1. Ownership check — account_id must belong to user_id.
 *   2. Idempotency check — same (user_id, raw_pdf_hash) → return early.
 *   3. PDF parse via injected parsePdf adapter.
 *   4. reconcileStatement — hard gate. Row is written with reconciled=false if
 *      it fails; the call still returns (the upload is auditable).
 *   5. buildChainCheck — soft warn. Never aborts.
 *   6. Persist arq_statement_imports row.
 *   7. TODO (#517): insert parsed transactions into transactions table.
 *
 * @param deps  - Injected dependencies (PDF parser).
 * @param input - User context + raw bytes + pre-computed PDF hash.
 */
export async function runStatementImport(
  deps: RunStatementImportDeps,
  input: {
    userId: number;
    accountId: number;
    pdfBuffer: Buffer;
    pdfHash: string;
  },
): Promise<RunStatementImportResult> {
  const { userId, accountId, pdfBuffer, pdfHash } = input;

  // ------------------------------------------------------------------
  // Step 1: Tenant ownership check.
  // Query accounts scoped by user_id AND account id — prevents cross-tenant
  // abuse where a malicious caller supplies another user's account_id.
  // ------------------------------------------------------------------
  const accountRow = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, accountId), eq(accounts.userId, userId)),
    columns: { id: true },
  });

  if (!accountRow) {
    log.warn(
      {
        event: "arq_import_account_not_found",
        userId,
        accountId,
      },
      "account not found for user — rejecting import (cross-tenant guard)",
    );
    return {
      status: "error",
      error: `Account ${accountId} does not belong to user ${userId}`,
    };
  }

  // ------------------------------------------------------------------
  // Step 2: Idempotency — same PDF hash for this user → already imported.
  // Scoped by user_id (not global hash) so two users importing the same
  // file do not interfere with each other.
  // ------------------------------------------------------------------
  const existing = await db.query.arqStatementImports.findFirst({
    where: and(eq(arqStatementImports.userId, userId), eq(arqStatementImports.rawPdfHash, pdfHash)),
    columns: { id: true },
  });

  if (existing) {
    log.info(
      {
        event: "arq_import_already_imported",
        userId,
        accountId,
        pdfHash,
        existingImportId: existing.id,
      },
      "PDF already imported — returning early",
    );
    return { status: "already_imported", importId: existing.id };
  }

  // ------------------------------------------------------------------
  // Step 3: Parse PDF.
  // ------------------------------------------------------------------
  let rawStatement: RawStatement;
  try {
    rawStatement = await deps.parsePdf(pdfBuffer);
  } catch (err) {
    log.error({ event: "arq_import_parse_error", userId, accountId, err }, "PDF parse failed");
    return { status: "error", error: `PDF parse failed: ${String(err)}` };
  }

  // ------------------------------------------------------------------
  // Step 4: Type-handler dispatch.
  // ------------------------------------------------------------------
  const parsedTxs = parseStatementTransactions(rawStatement);

  // ------------------------------------------------------------------
  // Step 5: Balance reconciliation (hard gate).
  // ------------------------------------------------------------------
  const reconcile = reconcileStatement(rawStatement, parsedTxs);

  // ------------------------------------------------------------------
  // Step 6: Inter-month chain check (soft warn).
  // Find the most-recent prior statement for this (user, account) pair
  // whose period_end is strictly before the current period_start.
  // Query is scoped by BOTH user_id AND account_id (tenant safety).
  // ------------------------------------------------------------------
  const currentPeriodStart = rawStatement.header.periodStart;

  const priorImport = await db.query.arqStatementImports.findFirst({
    where: and(
      eq(arqStatementImports.userId, userId),
      eq(arqStatementImports.accountId, accountId),
      // period_end < current period_start
      lt(arqStatementImports.periodEnd, currentPeriodStart.toISOString().slice(0, 10)),
      // Only chain off verified prior statements — a row with reconciled=false
      // has unreliable balances and would produce a misleading chain mismatch.
      eq(arqStatementImports.reconciled, true),
    ),
    orderBy: [desc(arqStatementImports.periodEnd)],
    columns: { declaredEndCents: true },
  });

  const previousEndCents = priorImport?.declaredEndCents ?? null;
  const chainCheck = buildChainCheck(rawStatement, previousEndCents);

  const preview: StatementImportPreview = { reconcile, chainCheck, parsedTxs };

  // ------------------------------------------------------------------
  // Step 7: Persist audit row.
  // Written regardless of reconciliation result — the row captures
  // the full outcome for auditability.
  // ------------------------------------------------------------------
  const activeTxs = parsedTxs.filter((tx) => tx.kind !== "skip");

  let insertedRow: { id: number } | undefined;
  try {
    [insertedRow] = await db
      .insert(arqStatementImports)
      .values({
        userId,
        accountId,
        periodStart: rawStatement.header.periodStart.toISOString().slice(0, 10),
        periodEnd: rawStatement.header.periodEnd.toISOString().slice(0, 10),
        declaredStartCents: reconcile.declaredStartCents,
        declaredEndCents: reconcile.declaredEndCents,
        parsedCount: activeTxs.length,
        parsedSumCents: reconcile.parsedSumCents,
        reconciled: reconcile.ok,
        reconcileDiffCents: reconcile.ok ? null : reconcile.diffCents,
        chainOk: chainCheck.chainOk,
        rawPdfHash: pdfHash,
      })
      .returning({ id: arqStatementImports.id });
  } catch (err) {
    // Postgres unique_violation. Two paths land here:
    //   - (user_id, account_id, period_start) collision — a different PDF
    //     covering an already-imported period (e.g. amended statement).
    //     The hash-based idempotency check above only catches identical bytes.
    //   - (user_id, raw_pdf_hash) collision — extremely unlikely race after
    //     the early-return guard, but defended here too.
    // Drizzle wraps the original error, so the pg code lives on err.cause.
    const errObj = err as { code?: string; cause?: { code?: string } } | null;
    const code = errObj?.code ?? errObj?.cause?.code;
    if (code === "23505") {
      log.warn(
        { event: "arq_import_period_conflict", userId, accountId },
        "statement for this period is already imported",
      );
      return {
        status: "error",
        error: "A statement for this period has already been imported.",
      };
    }
    throw err;
  }

  if (!insertedRow) {
    log.error(
      { event: "arq_import_insert_failed", userId, accountId },
      "failed to insert arq_statement_imports row",
    );
    return { status: "error", error: "Failed to persist import record" };
  }

  const importId = insertedRow.id;

  if (!reconcile.ok) {
    log.error(
      {
        event: "arq_import_reconcile_failed",
        importId,
        userId,
        accountId,
        errors: reconcile.errors,
      },
      "statement failed reconciliation — transactions NOT inserted",
    );
    return { status: "reconcile_failed", preview, importId };
  }

  // ------------------------------------------------------------------
  // Step 8 (#562c): upsert account_snapshots row.
  // Records the opening balance for this statement period so that
  // derivedBalanceCentsSql can anchor on it instead of summing all
  // transactions from the beginning of time.
  // Gate: reconcile.ok is guaranteed true here (we returned early above
  // if it was false).
  // ------------------------------------------------------------------
  const snapshotDate = rawStatement.header.periodStart.toISOString().slice(0, 10);
  try {
    await db
      .insert(accountSnapshots)
      .values({
        userId,
        accountId,
        snapshotDate,
        balanceCents: reconcile.declaredStartCents,
        metadata: { source: "arq_statement_import", importId },
      })
      .onConflictDoUpdate({
        target: [accountSnapshots.accountId, accountSnapshots.snapshotDate],
        set: {
          balanceCents: sql`excluded.balance_cents`,
          metadata: sql`excluded.metadata`,
        },
      });
    log.info(
      {
        event: "arq_import_snapshot_upserted",
        importId,
        userId,
        accountId,
        snapshotDate,
        balanceCents: reconcile.declaredStartCents.toString(),
      },
      "account_snapshots upserted for period start",
    );
  } catch (err) {
    // Non-fatal: snapshot write failure should not abort the import.
    // The import row is already committed and the reconciler will still run.
    log.error(
      { event: "arq_import_snapshot_failed", importId, userId, accountId, err },
      "failed to upsert account_snapshots — balance derivation will fall back to SUM(all txs)",
    );
  }

  // ------------------------------------------------------------------
  // Step 9 (#517): cross-channel dedup reconciler.
  // Merges statement txs with existing gmail_arq email rows; inserts
  // statement-only events; flags email orphans and diverged merges.
  // ------------------------------------------------------------------
  const periodStart = rawStatement.header.periodStart;
  const periodEnd = rawStatement.header.periodEnd;

  const reconcilerResult = await reconcileEmailVsStatement(deps.reconcilerDeps ?? {}, {
    userId,
    accountId,
    importId,
    period: { start: periodStart, end: periodEnd },
    parsedTxs,
  });

  log.info(
    {
      event: "arq_import_committed",
      importId,
      userId,
      accountId,
      parsedCount: activeTxs.length,
      chainOk: chainCheck.chainOk,
      insertedTxCount: reconcilerResult.insertedCount,
      mergedTxCount: reconcilerResult.mergedCount,
      flaggedTxCount: reconcilerResult.flaggedCount,
      emailOrphanCount: reconcilerResult.emailOrphanCount,
    },
    "ARQ statement import committed",
  );

  return {
    status: "committed",
    importId,
    preview,
    insertedTxCount: reconcilerResult.insertedCount,
    insertedTxIds: reconcilerResult.insertedIds,
    mergedTxCount: reconcilerResult.mergedCount,
    flaggedTxCount: reconcilerResult.flaggedCount,
    emailOrphanCount: reconcilerResult.emailOrphanCount,
  };
}
