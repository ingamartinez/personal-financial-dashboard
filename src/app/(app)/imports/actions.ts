"use server";

// /imports server actions — preview/commit split pattern.
//
// This file contains TWO generations of actions:
//
//   Generation 1 (ARQ-only, for Phase 3 rollback):
//     previewArqStatement / commitArqStatement
//   These are thin backward-compat wrappers kept until Phase 3 soak completes.
//   DO NOT DELETE before Phase 3 soak gate is confirmed by the user.
//
//   Generation 2 (unified, Phase 2):
//     previewIngestion / commitIngestion
//   These consume the unified dispatcher and route to the correct commit
//   pipeline based on the detected IngestionKind.
//
// Token cache: in-process Map with per-entry expiry. TTL = 5 min for all kinds
// (design Decision #1 — measure before bumping). Entries carry userId so commit
// can reject cross-user token replays.
//
// Tenant safety: every account ownership check filters userId from session.
// (Memory: per-user-table-join-tenant-safety)
//
// Logging: Pino only. Never concat user input into message strings.
// (Memory: feedback-centralized-logger, codeql-log-injection-sanitizer-patterns)

import crypto from "node:crypto";
import { and, desc, eq, gte, lt, lte, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { accounts, arqStatementImports } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createLogger } from "@/lib/logger";
import { buildChainCheck, reconcileStatement } from "@/lib/ingestion/arq-statement/balance";
import { parseArqStatementPdf } from "@/lib/ingestion/arq-statement/pdf-adapter";
import { parseStatementTransactions } from "@/lib/ingestion/arq-statement/type-handlers";
import { runStatementImport } from "@/lib/ingestion/arq-statement/run-statement-import";
import { classifyByRuleThenEnqueue } from "@/lib/classification/enqueue";
import {
  parseAndHint,
  resolveAccountHint,
  UnsupportedFileKindError,
} from "@/lib/ingestion/dispatch";
import { hashFileBuffer } from "@/lib/reconciliation/commit";
import { commitReconciliation, type CommitResult } from "@/lib/reconciliation/commit";
import { matchStatement } from "@/lib/reconciliation/engine/match";
import { applyPagoTcRouting } from "@/lib/reconciliation/pago-tc-router";
import { expandReconcileWindow } from "@/app/(app)/settings/accounts/[accountId]/reconcile/window";
import {
  consolidateCycleFromStatement,
  hashStatementBuffer,
} from "@/lib/ingestion/bancolombia-statement/consolidate";
import { hintSchema } from "./_dispatch-ui-types";

import type { IngestionKind, ReconciliationParsedStatement } from "@/lib/ingestion/dispatch-types";
import type { ExistingTxnForMatch, MatchingPlan } from "@/lib/reconciliation/engine/types";
import type { ParsedStatement as BancolombiaStatementParsed } from "@/lib/ingestion/bancolombia-statement/types";
import type {
  ImportPreviewResultV2,
  UnifiedCommitResult,
  SerializableConsolidationReport,
  MultiCurrencyInfo,
  ArqPreviewResult,
  BancolombiaPreviewResult,
  TcDetalladoPreviewResult,
} from "./_dispatch-ui-types";
import type { ImportPreviewResult, ImportCommitResult } from "./_types";
import { transactions } from "@/lib/db/schema";

const log = createLogger({ module: "imports-actions" });

// ---------------------------------------------------------------------------
// Preview token cache — shared across both action generations
// ---------------------------------------------------------------------------

const PREVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes for ALL kinds (design Decision #1)

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

// CacheEntry — v1 shape kept for backward compat (previewArqStatement)
interface CacheEntryV1 {
  version: 1;
  userId: number;
  accountId: number;
  pdfBuffer: Buffer;
  pdfHash: string;
  preview: ImportPreviewResult;
  expiresAt: number;
}

// CacheEntry — v2 shape for the unified previewIngestion action
interface CacheEntryV2 {
  version: 2;
  kind: IngestionKind;
  userId: number;
  accountId: number | null; // null when kind requires user dropdown selection
  fileBuffer: Buffer;
  fileHash: string;
  expiresAt: number;
  // Kind-specific parsed data for the commit pipeline
  arqData?: {
    pdfBuffer: Buffer;
    pdfHash: string;
    preview: ImportPreviewResult;
  };
  bancolombiaData?: {
    parsed: ReconciliationParsedStatement;
    plan: MatchingPlan;
    siblingAccountId?: number;
  };
  tcDetalladoData?: {
    parsedSheets: BancolombiaStatementParsed[];
    cycle: string;
    siblingAccountId?: number;
    fileHash: string;
  };
}

type CacheEntry = CacheEntryV1 | CacheEntryV2;

const previewCache = new Map<string, CacheEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [token, entry] of previewCache) {
    if (entry.expiresAt <= now) {
      previewCache.delete(token);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function validatePdfBytes(buf: Buffer): string | null {
  if (buf.byteLength > MAX_PDF_BYTES) {
    return `El archivo supera el límite de 10 MB (${(buf.byteLength / 1_048_576).toFixed(1)} MB).`;
  }
  if (buf.subarray(0, 4).compare(PDF_MAGIC) !== 0) {
    return "El archivo no parece ser un PDF válido.";
  }
  return null;
}

async function loadExistingTxns(
  userId: number,
  accountId: number,
  periodStart: Date,
  periodEnd: Date,
): Promise<ExistingTxnForMatch[]> {
  const { windowStart, windowEnd } = expandReconcileWindow(periodStart, periodEnd);
  const rowsWithRange = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
      channel: transactions.channel,
      isAdjustment: transactions.isAdjustment,
      reconciliationStatus: transactions.reconciliationStatus,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        notDeleted(transactions.deletedAt),
      ),
    );
  return rowsWithRange.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    amountCents: r.amountCents,
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
    merchant: r.merchant,
    channel: r.channel,
    isAdjustment: r.isAdjustment,
    reconciliationStatus: r.reconciliationStatus,
  }));
}

async function loadAccountOwned(userId: number, accountId: number) {
  const [account] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institution: accounts.institution,
      institutionSlug: accounts.institutionSlug,
      physicalCardId: accounts.physicalCardId,
      metadata: accounts.metadata,
      type: accounts.type,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);
  return account ?? null;
}

// ---------------------------------------------------------------------------
// T2.2 — previewIngestion
// ---------------------------------------------------------------------------

export async function previewIngestion(formData: FormData): Promise<ImportPreviewResultV2> {
  const session = await getSessionUser();
  const userId = session.id;

  // --- Extract file ---
  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    log.warn({ event: "preview_no_file", userId }, "no file in FormData");
    throw new Error("No se recibió ningún archivo.");
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  // --- Parse hints from FormData ---
  const rawHintAccountId = formData.get("hint_account_id");
  const rawHintCycle = formData.get("hint_cycle");
  const hintParse = hintSchema.safeParse({
    hint_account_id: rawHintAccountId ?? undefined,
    hint_cycle: rawHintCycle ?? undefined,
  });
  const hints = hintParse.success ? hintParse.data : {};

  // --- Validate hint_account_id ownership before use (AC-19) ---
  let validatedHintAccountId: number | null = null;
  if (hints.hint_account_id) {
    const hintAccount = await loadAccountOwned(userId, hints.hint_account_id);
    if (!hintAccount) {
      log.info(
        { event: "account_hint_not_owned", hintedAccountId: hints.hint_account_id, userId },
        "hint_account_id not owned by session user — ignoring",
      );
      validatedHintAccountId = null;
    } else {
      validatedHintAccountId = hintAccount.id;
    }
  }

  // --- Detect + parse ---
  let dispatchResult;
  try {
    dispatchResult = await parseAndHint(buffer, { userId });
  } catch (err) {
    if (err instanceof UnsupportedFileKindError) {
      log.warn({ event: "unsupported_file_kind", userId }, err.message);
      throw new Error(err.message);
    }
    log.error({ err, event: "parse_failed", userId }, "parseAndHint failed");
    throw new Error("No se pudo procesar el archivo. Verificá que sea un extracto válido.");
  }

  // --- format_unknown early return (AC-22) ---
  if (dispatchResult.kind === "format_unknown") {
    return { kind: "format_unknown", needsManualKindPick: true };
  }

  // --- Resolve account hint from file headers ---
  const fileAccountHint = await resolveAccountHint(userId, dispatchResult);

  // Account resolution priority: file header → url hint → required user selection
  const resolvedAccountId = fileAccountHint?.accountId ?? validatedHintAccountId ?? null;

  evictExpired();
  const token = crypto.randomUUID();

  // --- ARQ PDF ---
  if (dispatchResult.kind === "arq-pdf") {
    const rawStatement = dispatchResult.rawStatement;

    // Validate file size (dispatcher already checks, but belt + suspenders)
    const validationError = validatePdfBytes(buffer);
    if (validationError) throw new Error(validationError);

    const pdfHash = crypto.createHash("sha256").update(buffer).digest("hex");

    // Idempotency check
    const existing = await db.query.arqStatementImports.findFirst({
      where: and(
        eq(arqStatementImports.userId, userId),
        eq(arqStatementImports.rawPdfHash, pdfHash),
      ),
      columns: { id: true, importedAt: true },
    });
    if (existing) {
      const importedAt = existing.importedAt.toLocaleDateString("es-CO", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      });
      throw new Error(`Este extracto ya fue importado el ${importedAt}.`);
    }

    // Resolve account
    if (!resolvedAccountId) {
      throw new Error(
        "Este extracto no corresponde a ninguna cuenta tuya. Verificá que sea el archivo correcto.",
      );
    }
    const account = await loadAccountOwned(userId, resolvedAccountId);
    if (!account) {
      throw new Error("Cuenta no encontrada.");
    }
    const accountLabel = formatAccountLabel(account);

    // Pure reconciliation
    const parsedTxs = parseStatementTransactions(rawStatement);
    const reconcile = reconcileStatement(rawStatement, parsedTxs);
    const currentPeriodStart = rawStatement.header.periodStart;
    const priorImport = await db.query.arqStatementImports.findFirst({
      where: and(
        eq(arqStatementImports.userId, userId),
        eq(arqStatementImports.accountId, resolvedAccountId),
        lt(arqStatementImports.periodEnd, currentPeriodStart.toISOString().slice(0, 10)),
        eq(arqStatementImports.reconciled, true),
      ),
      orderBy: [desc(arqStatementImports.periodEnd)],
      columns: { declaredEndCents: true },
    });
    const previousEndCents = priorImport?.declaredEndCents ?? null;
    const chainCheck = buildChainCheck(rawStatement, previousEndCents);
    const activeTxCount = parsedTxs.filter((tx) => tx.kind !== "skip").length;

    const preview: ImportPreviewResult = {
      token,
      accountLabel,
      period: {
        start: rawStatement.header.periodStart.toISOString().slice(0, 10),
        end: rawStatement.header.periodEnd.toISOString().slice(0, 10),
      },
      parsedCount: activeTxCount,
      balanceCheck: {
        ok: reconcile.ok,
        declaredStartCents: String(reconcile.declaredStartCents),
        declaredEndCents: String(reconcile.declaredEndCents),
        declaredCreditsCents: String(reconcile.declaredCreditsCents),
        declaredDebitsCents: String(reconcile.declaredDebitsCents),
        parsedSumCents: String(reconcile.parsedSumCents),
        diffCents: String(reconcile.diffCents),
        errors: reconcile.errors,
        warnings: reconcile.warnings,
      },
      chainCheck: {
        chainOk: chainCheck.chainOk,
        previousEndCents:
          chainCheck.previousEndCents !== null ? String(chainCheck.previousEndCents) : null,
        currentStartCents: String(chainCheck.currentStartCents),
        diffCents: chainCheck.diffCents !== null ? String(chainCheck.diffCents) : null,
      },
      mergePreview: { parsedCount: activeTxCount, estimatedMergeCount: 0 },
      errors: reconcile.errors,
    };

    previewCache.set(token, {
      version: 2,
      kind: "arq-pdf",
      userId,
      accountId: resolvedAccountId,
      fileBuffer: buffer,
      fileHash: pdfHash,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      arqData: { pdfBuffer: buffer, pdfHash, preview },
    });

    log.info(
      { event: "preview_cached_arq", userId, accountId: resolvedAccountId, token },
      "ARQ preview cached",
    );

    const result: ArqPreviewResult = {
      kind: "arq-pdf",
      token,
      accountLabel,
      period: preview.period,
      parsedCount: activeTxCount,
      balanceCheck: preview.balanceCheck,
      chainCheck: preview.chainCheck,
      mergePreview: preview.mergePreview,
      errors: preview.errors,
    };
    return result;
  }

  // --- Bancolombia savings / extracto / tc-legacy ---
  if (
    dispatchResult.kind === "bancolombia-savings" ||
    dispatchResult.kind === "bancolombia-extracto" ||
    dispatchResult.kind === "bancolombia-tc-legacy"
  ) {
    const parsed = dispatchResult.parsed;
    const fileHash = hashFileBuffer(buffer);

    if (!resolvedAccountId) {
      // Return a preview without token — UI will require account selection
      const result: BancolombiaPreviewResult = {
        kind: dispatchResult.kind,
        token: "",
        accountLabel: "(seleccioná una cuenta)",
        period: {
          start: parsed.periodStart.toISOString().slice(0, 10),
          end: parsed.periodEnd.toISOString().slice(0, 10),
        },
        rowCount: parsed.rowCount,
        matched: 0,
        newInserts: 0,
        nearMatches: 0,
        flaggedExisting: 0,
        fileHash,
        multiCurrency: null,
      };
      return result;
    }

    const account = await loadAccountOwned(userId, resolvedAccountId);
    if (!account) throw new Error("Cuenta no encontrada.");

    const accountLabel = formatAccountLabel(account);

    // Resolve multi-currency dispatch
    let siblingAccountId: number | undefined;
    let multiCurrency: MultiCurrencyInfo | null = null;
    const currenciesInFile = new Set(parsed.rows.map((r) => r.currency));

    if (currenciesInFile.size > 1 && account.physicalCardId) {
      const [sibling] = await db
        .select({
          id: accounts.id,
          name: accounts.name,
          currency: accounts.currency,
          institution: accounts.institution,
          metadata: accounts.metadata,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.physicalCardId, account.physicalCardId),
            ne(accounts.id, resolvedAccountId),
            notDeleted(accounts.deletedAt),
          ),
        )
        .limit(1);

      if (sibling) {
        siblingAccountId = sibling.id;
        const rowsByCurrency: Record<"COP" | "USD", number> = { COP: 0, USD: 0 };
        for (const r of parsed.rows) rowsByCurrency[r.currency] += 1;
        multiCurrency = {
          siblingAccountId: sibling.id,
          siblingAccountLabel: formatAccountLabel(sibling),
          rowsByCurrency,
        };
      }
    }

    // Build matching plan
    const existingOrigin = await loadExistingTxns(
      userId,
      resolvedAccountId,
      parsed.periodStart,
      parsed.periodEnd,
    );
    const existingSibling = siblingAccountId
      ? await loadExistingTxns(userId, siblingAccountId, parsed.periodStart, parsed.periodEnd)
      : [];
    const existing: ExistingTxnForMatch[] = [...existingOrigin, ...existingSibling];
    const plan = matchStatement({
      parsedRows: parsed.rows,
      existingTxns: existing,
      period: { start: parsed.periodStart, end: parsed.periodEnd },
    });

    previewCache.set(token, {
      version: 2,
      kind: dispatchResult.kind,
      userId,
      accountId: resolvedAccountId,
      fileBuffer: buffer,
      fileHash,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      bancolombiaData: { parsed, plan, siblingAccountId },
    });

    log.info(
      {
        event: "preview_cached_bancolombia",
        kind: dispatchResult.kind,
        userId,
        accountId: resolvedAccountId,
        token,
      },
      "Bancolombia preview cached",
    );

    const result: BancolombiaPreviewResult = {
      kind: dispatchResult.kind,
      token,
      accountLabel,
      period: {
        start: parsed.periodStart.toISOString().slice(0, 10),
        end: parsed.periodEnd.toISOString().slice(0, 10),
      },
      rowCount: parsed.rowCount,
      matched: plan.summary.matched,
      newInserts: plan.summary.newInserts,
      nearMatches: plan.summary.nearMatches,
      flaggedExisting: plan.summary.flaggedExisting,
      fileHash,
      multiCurrency,
    };
    return result;
  }

  // --- TC Detallado ---
  if (dispatchResult.kind === "bancolombia-tc-detallado") {
    const parsedSheets = dispatchResult.parsedSheets;
    const cycleHint = dispatchResult.cycleHint.cycle;
    const fileHash = hashStatementBuffer(buffer);

    if (!resolvedAccountId) {
      const result: TcDetalladoPreviewResult = {
        kind: "bancolombia-tc-detallado",
        token: "",
        accountLabel: "(seleccioná una cuenta)",
        period: {
          start: parsedSheets[0]?.period.startDate.toISOString().slice(0, 10) ?? "",
          end: parsedSheets[0]?.period.endDate.toISOString().slice(0, 10) ?? "",
        },
        cycle: cycleHint,
        reports: [],
        multiCurrency: null,
      };
      return result;
    }

    const account = await loadAccountOwned(userId, resolvedAccountId);
    if (!account) throw new Error("Cuenta no encontrada.");
    const accountLabel = formatAccountLabel(account);

    // Resolve multi-currency sibling
    let siblingAccountId: number | undefined;
    let multiCurrency: MultiCurrencyInfo | null = null;
    if (parsedSheets.length >= 2 && account.physicalCardId) {
      const [sibling] = await db
        .select({
          id: accounts.id,
          name: accounts.name,
          currency: accounts.currency,
          institution: accounts.institution,
          metadata: accounts.metadata,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.physicalCardId, account.physicalCardId),
            ne(accounts.id, resolvedAccountId),
            notDeleted(accounts.deletedAt),
          ),
        )
        .limit(1);

      if (sibling) {
        siblingAccountId = sibling.id;
        const rowsByCurrency: Record<"COP" | "USD", number> = { COP: 0, USD: 0 };
        for (const sheet of parsedSheets) {
          const cur = sheet.account.currency as "COP" | "USD";
          rowsByCurrency[cur] = (rowsByCurrency[cur] ?? 0) + sheet.rows.length;
        }
        multiCurrency = {
          siblingAccountId: sibling.id,
          siblingAccountLabel: formatAccountLabel(sibling),
          rowsByCurrency,
        };
      }
    }

    // Dry-run consolidation reports
    const reports: SerializableConsolidationReport[] = [];
    for (const sheet of parsedSheets) {
      const sheetCurrency = sheet.account.currency as "COP" | "USD";
      const targetAccountId =
        sheetCurrency === account.currency
          ? resolvedAccountId
          : (siblingAccountId ?? resolvedAccountId);

      // Verify target account belongs to user (AC-15)
      const targetAccount = await loadAccountOwned(userId, targetAccountId);
      if (!targetAccount) {
        log.error(
          { event: "tc_detallado_account_not_owned", userId, targetAccountId },
          "TC detallado target account not owned by user",
        );
        throw new Error("Una de las cuentas de destino no pertenece a tu usuario.");
      }

      const r = await consolidateCycleFromStatement({
        userId,
        accountId: targetAccountId,
        cycle: cycleHint,
        parsed: sheet,
        fileHash,
        dryRun: true,
      });
      reports.push({
        accountId: targetAccountId,
        accountLabel: formatAccountLabel(targetAccount),
        cycle: cycleHint,
        status: r.status,
        matchStats: {
          matched: r.matchStats.matched,
          matchedWillChange: r.matchStats.matchedWillChange,
          insertedMissing: r.matchStats.insertedMissing,
          unmatchedInLedger: r.matchStats.unmatchedInLedger,
        },
        intereses: {
          status: r.intereses.status,
          txId: "txId" in r.intereses ? (r.intereses.txId as number | undefined) : undefined,
          reason: "reason" in r.intereses ? (r.intereses.reason as string | undefined) : undefined,
        },
      });
    }

    const firstSheet = parsedSheets[0];
    previewCache.set(token, {
      version: 2,
      kind: "bancolombia-tc-detallado",
      userId,
      accountId: resolvedAccountId,
      fileBuffer: buffer,
      fileHash,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
      tcDetalladoData: { parsedSheets, cycle: cycleHint, siblingAccountId, fileHash },
    });

    log.info(
      {
        event: "preview_cached_tc_detallado",
        userId,
        accountId: resolvedAccountId,
        token,
        cycle: cycleHint,
      },
      "TC detallado preview cached",
    );

    const result: TcDetalladoPreviewResult = {
      kind: "bancolombia-tc-detallado",
      token,
      accountLabel,
      period: {
        start: firstSheet?.period.startDate.toISOString().slice(0, 10) ?? "",
        end: firstSheet?.period.endDate.toISOString().slice(0, 10) ?? "",
      },
      cycle: cycleHint,
      reports,
      multiCurrency,
    };
    return result;
  }

  // Should not reach here — TypeScript exhaustive check guard
  throw new Error("Formato de archivo no reconocido.");
}

// ---------------------------------------------------------------------------
// T2.3 — commitIngestion
// ---------------------------------------------------------------------------

export async function commitIngestion(
  token: string,
  overrides?: { accountId?: number },
): Promise<UnifiedCommitResult> {
  const session = await getSessionUser();
  const userId = session.id;

  evictExpired();

  const entry = previewCache.get(token);
  if (!entry) {
    log.warn(
      { event: "commit_token_expired", userId, token },
      "preview token not found or expired",
    );
    return {
      kind: "arq-pdf",
      status: "expired",
      error: "La sesión de preview expiró. Subí el archivo nuevamente.",
    };
  }

  // Cross-user token replay guard (AC-12)
  if (entry.userId !== userId) {
    log.error(
      {
        event: "commit_token_user_mismatch",
        requestingUserId: userId,
        tokenUserId: entry.userId,
        token,
      },
      "token user mismatch — possible cross-user replay",
    );
    // Determine kind from entry for typed return
    const kind = entry.version === 2 ? entry.kind : "arq-pdf";
    return { kind, status: "error", error: "Token inválido." } as UnifiedCommitResult;
  }

  // Single-use: delete immediately (AC-13)
  previewCache.delete(token);

  // Validate override accountId ownership if provided
  let effectiveAccountId = entry.accountId;
  if (overrides?.accountId && overrides.accountId !== entry.accountId) {
    const overrideAccount = await loadAccountOwned(userId, overrides.accountId);
    if (!overrideAccount) {
      log.error(
        {
          event: "commit_override_account_not_owned",
          userId,
          overrideAccountId: overrides.accountId,
        },
        "override accountId not owned by user",
      );
      const kind = entry.version === 2 ? entry.kind : "arq-pdf";
      return {
        kind,
        status: "error",
        error: "La cuenta seleccionada no te pertenece.",
      } as UnifiedCommitResult;
    }
    effectiveAccountId = overrides.accountId;
  }

  if (entry.version === 1) {
    // V1 entry — delegate to ARQ pipeline (backward compat)
    return _commitArqV1(entry, userId);
  }

  // V2 entry — branch by kind
  const v2 = entry as CacheEntryV2;

  if (v2.kind === "arq-pdf" && v2.arqData) {
    return _commitArqV2(v2, effectiveAccountId!, userId);
  }

  if (
    (v2.kind === "bancolombia-savings" ||
      v2.kind === "bancolombia-extracto" ||
      v2.kind === "bancolombia-tc-legacy") &&
    v2.bancolombiaData
  ) {
    return _commitBancolombia(v2, effectiveAccountId!, userId);
  }

  if (v2.kind === "bancolombia-tc-detallado" && v2.tcDetalladoData) {
    return _commitTcDetallado(v2, effectiveAccountId!, userId);
  }

  log.error(
    { event: "commit_unknown_kind", userId, kind: v2.kind, token },
    "unknown cache entry kind",
  );
  return { kind: v2.kind, status: "error", error: "Error interno." } as UnifiedCommitResult;
}

async function _commitArqV1(entry: CacheEntryV1, userId: number): Promise<UnifiedCommitResult> {
  log.info(
    { event: "commit_arq_v1", userId, accountId: entry.accountId },
    "committing ARQ v1 entry",
  );
  const result = await runStatementImport(
    { parsePdf: parseArqStatementPdf },
    { userId, accountId: entry.accountId, pdfBuffer: entry.pdfBuffer, pdfHash: entry.pdfHash },
  );
  // #591: run rule-based classification on newly inserted txs, then enqueue AI for the rest.
  if (result.status === "committed" && result.insertedTxIds && result.insertedTxIds.length > 0) {
    await classifyByRuleThenEnqueue(userId, result.insertedTxIds);
  }
  return _mapArqRunResult(result, entry.preview.period);
}

async function _commitArqV2(
  entry: CacheEntryV2,
  accountId: number,
  userId: number,
): Promise<UnifiedCommitResult> {
  const { pdfBuffer, pdfHash, preview } = entry.arqData!;
  log.info({ event: "commit_arq_v2", userId, accountId }, "committing ARQ v2 entry");
  const result = await runStatementImport(
    { parsePdf: parseArqStatementPdf },
    { userId, accountId, pdfBuffer, pdfHash },
  );
  // #591: run rule-based classification on newly inserted txs, then enqueue AI for the rest.
  if (result.status === "committed" && result.insertedTxIds && result.insertedTxIds.length > 0) {
    await classifyByRuleThenEnqueue(userId, result.insertedTxIds);
  }
  return _mapArqRunResult(result, preview.period);
}

function _mapArqRunResult(
  result: Awaited<ReturnType<typeof runStatementImport>>,
  period: { start: string; end: string },
): UnifiedCommitResult {
  switch (result.status) {
    case "committed":
      return {
        kind: "arq-pdf",
        status: "committed",
        importId: result.importId,
        insertedCount: result.insertedTxCount,
        mergedCount: result.mergedTxCount,
        flaggedCount: result.flaggedTxCount,
        emailOrphanCount: result.emailOrphanCount,
        period,
      };
    case "reconcile_failed":
      return { kind: "arq-pdf", status: "error", error: "El parser no logró cuadrar los números." };
    case "already_imported":
      return { kind: "arq-pdf", status: "already_imported", importId: result.importId };
    case "error":
      return { kind: "arq-pdf", status: "error", error: result.error };
  }
}

async function _commitBancolombia(
  entry: CacheEntryV2,
  accountId: number,
  userId: number,
): Promise<UnifiedCommitResult> {
  const { parsed, plan, siblingAccountId } = entry.bancolombiaData!;
  const kind = entry.kind as
    | "bancolombia-savings"
    | "bancolombia-extracto"
    | "bancolombia-tc-legacy";

  log.info(
    { event: "commit_bancolombia", kind, userId, accountId },
    "committing Bancolombia entry",
  );

  const account = await loadAccountOwned(userId, accountId);
  if (!account) return { kind, status: "error", error: "Cuenta no encontrada." };

  let siblingAccount: { id: number; currency: "COP" | "USD" } | undefined;
  if (siblingAccountId) {
    const sib = await loadAccountOwned(userId, siblingAccountId);
    if (!sib) {
      log.error(
        { event: "commit_sibling_not_owned", userId, siblingAccountId },
        "sibling account not owned — aborting commit",
      );
      return { kind, status: "error", error: "La cuenta sibling no pertenece a tu usuario." };
    }
    siblingAccount = { id: sib.id, currency: sib.currency };
  }

  const result: CommitResult = await commitReconciliation({
    userId,
    account: { id: account.id, currency: account.currency },
    siblingAccount,
    parsed,
    plan,
    fileHash: entry.fileHash,
  });

  // Pago TC routing for savings formats
  const isSavingsFormat =
    parsed.format === "bancolombia_savings" || parsed.format === "bancolombia_savings_extracto";
  if (result.status === "applied" && isSavingsFormat) {
    const pagoResult = await applyPagoTcRouting({
      userId,
      savingsAccountId: accountId,
      rows: parsed.rows,
    });
    log.info(
      { event: "pago_tc_routing_result", userId, accountId, ...pagoResult },
      "pago tc routing after savings reconciliation",
    );
  }

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath(`/settings/accounts/${accountId}/reconcile`);
  if (siblingAccountId) revalidatePath(`/settings/accounts/${siblingAccountId}/reconcile`);

  // #591: run rule-based classification on newly inserted txs, then enqueue AI for the rest.
  if (result.status === "applied" && result.insertedIds.length > 0) {
    await classifyByRuleThenEnqueue(userId, result.insertedIds);
  }

  return {
    kind,
    status: result.status === "applied" ? "committed" : "already_imported",
    inserted: result.inserted,
    matched: result.matched,
    flagged: result.flagged,
  };
}

async function _commitTcDetallado(
  entry: CacheEntryV2,
  accountId: number,
  userId: number,
): Promise<UnifiedCommitResult> {
  const { parsedSheets, cycle, siblingAccountId, fileHash } = entry.tcDetalladoData!;

  log.info(
    { event: "commit_tc_detallado", userId, accountId, cycle },
    "committing TC detallado entry",
  );

  // Verify origin account
  const originAccount = await loadAccountOwned(userId, accountId);
  if (!originAccount)
    return { kind: "bancolombia-tc-detallado", status: "error", error: "Cuenta no encontrada." };

  // Verify sibling if present (AC-15)
  let siblingAccount: Awaited<ReturnType<typeof loadAccountOwned>> | null = null;
  if (siblingAccountId) {
    siblingAccount = await loadAccountOwned(userId, siblingAccountId);
    if (!siblingAccount) {
      log.error(
        { event: "commit_tc_sibling_not_owned", userId, siblingAccountId },
        "TC detallado sibling not owned — aborting commit",
      );
      return {
        kind: "bancolombia-tc-detallado",
        status: "error",
        error: "La cuenta sibling no pertenece a tu usuario.",
      };
    }
  }

  const sheets: Array<{
    accountId: number;
    accountLabel: string;
    inserted: number;
    matched: number;
  }> = [];

  // #591: collect all inserted txIds across sheets for classification.
  const allInsertedTxIds: number[] = [];

  for (const sheet of parsedSheets) {
    const sheetCurrency = sheet.account.currency as "COP" | "USD";
    const targetAccountId =
      sheetCurrency === originAccount.currency ? accountId : (siblingAccountId ?? accountId);

    // Verify target (AC-15)
    const targetAccount = await loadAccountOwned(userId, targetAccountId);
    if (!targetAccount) {
      log.error(
        { event: "commit_tc_target_not_owned", userId, targetAccountId },
        "TC detallado target not owned — aborting",
      );
      return {
        kind: "bancolombia-tc-detallado",
        status: "error",
        error: "Una de las cuentas de destino no pertenece a tu usuario.",
      };
    }

    // Cycle is ALWAYS derived from file, NOT from user override (AC-17)
    const derivedCycle = cycle;

    const r = await consolidateCycleFromStatement({
      userId,
      accountId: targetAccountId,
      cycle: derivedCycle,
      parsed: sheet,
      fileHash,
      dryRun: false,
    });

    allInsertedTxIds.push(...(r.insertedTxIds ?? []));

    sheets.push({
      accountId: targetAccountId,
      accountLabel: formatAccountLabel(targetAccount),
      inserted: (r.insertedTxIds?.length ?? 0),
      matched: r.matchStats.matched,
    });
  }

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath(`/settings/accounts/${accountId}/consolidate/${cycle}`);
  if (siblingAccountId)
    revalidatePath(`/settings/accounts/${siblingAccountId}/consolidate/${cycle}`);

  // #591: run rule-based classification on newly inserted txs, then enqueue AI for the rest.
  if (allInsertedTxIds.length > 0) {
    await classifyByRuleThenEnqueue(userId, allInsertedTxIds);
  }

  log.info(
    {
      event: "commit_tc_detallado_done",
      userId,
      accountId,
      cycle,
      sheets: sheets.map((s) => ({ accountId: s.accountId, inserted: s.inserted })),
    },
    "TC detallado committed",
  );

  return {
    kind: "bancolombia-tc-detallado",
    status: "committed",
    cycle,
    sheets,
  };
}

// ---------------------------------------------------------------------------
// Generation 1 backward-compat wrappers
// (kept for Phase 3 rollback — DO NOT DELETE until soak gate confirmed)
// ---------------------------------------------------------------------------

export async function previewArqStatement(formData: FormData): Promise<ImportPreviewResult> {
  const session = await getSessionUser();
  const userId = session.id;

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    log.warn({ event: "arq_preview_no_file", userId }, "no file in FormData");
    throw new Error("No se recibió ningún archivo.");
  }

  const arrayBuf = await file.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuf);

  const validationError = validatePdfBytes(pdfBuffer);
  if (validationError) {
    log.warn(
      { event: "arq_preview_validation_failed", userId, bytes: pdfBuffer.byteLength },
      "pdf validation failed",
    );
    throw new Error(validationError);
  }

  const pdfHash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

  const existing = await db.query.arqStatementImports.findFirst({
    where: and(eq(arqStatementImports.userId, userId), eq(arqStatementImports.rawPdfHash, pdfHash)),
    columns: { id: true, periodStart: true, periodEnd: true, importedAt: true },
  });

  if (existing) {
    const importedAt = existing.importedAt.toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    throw new Error(`Este extracto ya fue importado el ${importedAt}.`);
  }

  let rawStatement;
  try {
    rawStatement = await parseArqStatementPdf(pdfBuffer);
  } catch (err) {
    log.error({ err, event: "arq_preview_parse_failed", userId }, "pdf parse failed");
    throw new Error("No se pudo leer el PDF. Verificá que sea un extracto ARQ válido.");
  }

  const accountNumber = rawStatement.header.accountNumber;
  const userAccounts = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institution: accounts.institution,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));

  const matchedAccount = userAccounts.find((a) => {
    const meta = a.metadata as Record<string, unknown> | null;
    if (meta?.accountNumber && String(meta.accountNumber) === accountNumber) return true;
    if (meta?.routingNumber) return true;
    if (a.institution && /arq|dolarapp/i.test(a.institution)) return true;
    return false;
  });

  if (!matchedAccount) {
    log.warn(
      { event: "arq_preview_account_mismatch", userId, accountNumber },
      "no matching account found",
    );
    throw new Error(
      "Este extracto no corresponde a ninguna cuenta tuya. Verificá que sea el archivo correcto.",
    );
  }

  const accountId = matchedAccount.id;
  const accountLabel = formatAccountLabel(matchedAccount);

  const parsedTxs = parseStatementTransactions(rawStatement);
  const reconcile = reconcileStatement(rawStatement, parsedTxs);
  const currentPeriodStart = rawStatement.header.periodStart;

  const priorImport = await db.query.arqStatementImports.findFirst({
    where: and(
      eq(arqStatementImports.userId, userId),
      eq(arqStatementImports.accountId, accountId),
      lt(arqStatementImports.periodEnd, currentPeriodStart.toISOString().slice(0, 10)),
      eq(arqStatementImports.reconciled, true),
    ),
    orderBy: [desc(arqStatementImports.periodEnd)],
    columns: { declaredEndCents: true },
  });

  const previousEndCents = priorImport?.declaredEndCents ?? null;
  const chainCheck = buildChainCheck(rawStatement, previousEndCents);
  const activeTxCount = parsedTxs.filter((tx) => tx.kind !== "skip").length;

  const preview: ImportPreviewResult = {
    token: "",
    accountLabel,
    period: {
      start: rawStatement.header.periodStart.toISOString().slice(0, 10),
      end: rawStatement.header.periodEnd.toISOString().slice(0, 10),
    },
    parsedCount: activeTxCount,
    balanceCheck: {
      ok: reconcile.ok,
      declaredStartCents: String(reconcile.declaredStartCents),
      declaredEndCents: String(reconcile.declaredEndCents),
      declaredCreditsCents: String(reconcile.declaredCreditsCents),
      declaredDebitsCents: String(reconcile.declaredDebitsCents),
      parsedSumCents: String(reconcile.parsedSumCents),
      diffCents: String(reconcile.diffCents),
      errors: reconcile.errors,
      warnings: reconcile.warnings,
    },
    chainCheck: {
      chainOk: chainCheck.chainOk,
      previousEndCents:
        chainCheck.previousEndCents !== null ? String(chainCheck.previousEndCents) : null,
      currentStartCents: String(chainCheck.currentStartCents),
      diffCents: chainCheck.diffCents !== null ? String(chainCheck.diffCents) : null,
    },
    mergePreview: { parsedCount: activeTxCount, estimatedMergeCount: 0 },
    errors: reconcile.errors,
  };

  evictExpired();
  const token = crypto.randomUUID();
  previewCache.set(token, {
    version: 1,
    userId,
    accountId,
    pdfBuffer,
    pdfHash,
    preview: { ...preview, token },
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  });

  log.info(
    {
      event: "arq_preview_cached",
      userId,
      accountId,
      token,
      parsedCount: activeTxCount,
      reconcileOk: reconcile.ok,
    },
    "ARQ statement preview cached",
  );

  return { ...preview, token };
}

export async function commitArqStatement(previewToken: string): Promise<ImportCommitResult> {
  const session = await getSessionUser();
  const userId = session.id;

  evictExpired();

  const entry = previewCache.get(previewToken);

  if (!entry) {
    log.warn(
      { event: "arq_commit_token_expired", userId, token: previewToken },
      "preview token not found or expired",
    );
    return { status: "expired", error: "La sesión de preview expiró. Subí el PDF nuevamente." };
  }

  if (entry.userId !== userId) {
    log.error(
      {
        event: "arq_commit_token_user_mismatch",
        requestingUserId: userId,
        tokenUserId: entry.userId,
        token: previewToken,
      },
      "token user mismatch — possible cross-user replay",
    );
    return { status: "error", error: "Token inválido." };
  }

  previewCache.delete(previewToken);

  if (entry.version === 2 && entry.kind === "arq-pdf" && entry.arqData) {
    const { pdfBuffer, pdfHash, preview } = entry.arqData;
    const result = await runStatementImport(
      { parsePdf: parseArqStatementPdf },
      { userId, accountId: entry.accountId!, pdfBuffer, pdfHash },
    );
    // #591: run rule-based classification on newly inserted txs, then enqueue AI for the rest.
    if (result.status === "committed" && result.insertedTxIds && result.insertedTxIds.length > 0) {
      await classifyByRuleThenEnqueue(userId, result.insertedTxIds);
    }
    return _mapCommitResult(result, preview.period);
  }

  if (entry.version !== 1) {
    return { status: "error", error: "Token inválido." };
  }

  log.info(
    { event: "arq_commit_start", userId, accountId: entry.accountId, token: previewToken },
    "committing ARQ statement import",
  );

  const result = await runStatementImport(
    { parsePdf: parseArqStatementPdf },
    { userId, accountId: entry.accountId, pdfBuffer: entry.pdfBuffer, pdfHash: entry.pdfHash },
  );
  // #591: run rule-based classification on newly inserted txs, then enqueue AI for the rest.
  if (result.status === "committed" && result.insertedTxIds && result.insertedTxIds.length > 0) {
    await classifyByRuleThenEnqueue(userId, result.insertedTxIds);
  }

  return _mapCommitResult(result, entry.preview.period);
}

function _mapCommitResult(
  result: Awaited<ReturnType<typeof runStatementImport>>,
  period: { start: string; end: string },
): ImportCommitResult {
  switch (result.status) {
    case "committed":
      log.info(
        {
          event: "arq_commit_done",
          importId: result.importId,
          insertedTxCount: result.insertedTxCount,
        },
        "ARQ statement committed",
      );
      return {
        status: "committed",
        importId: result.importId,
        insertedCount: result.insertedTxCount,
        mergedCount: result.mergedTxCount,
        flaggedCount: result.flaggedTxCount,
        emailOrphanCount: result.emailOrphanCount,
        period,
      };
    case "reconcile_failed":
      log.error(
        { event: "arq_commit_reconcile_failed", importId: result.importId },
        "statement reconciliation failed",
      );
      return {
        status: "reconcile_failed",
        importId: result.importId,
        error:
          "El parser no logró cuadrar los números. El extracto fue registrado para auditoría pero las transacciones NO fueron insertadas.",
      };
    case "already_imported":
      return { status: "already_imported", importId: result.importId };
    case "error":
      log.error(
        { event: "arq_commit_error", error: result.error },
        "runStatementImport returned error",
      );
      return { status: "error", error: result.error };
  }
}
