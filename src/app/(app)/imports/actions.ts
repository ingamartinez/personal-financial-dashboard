"use server";

// ARQ statement import server actions.
//
// Preview/commit split pattern:
//   1. previewArqStatement — parse + reconcile, store result in a server-side
//      in-memory cache with a 5-minute TTL. NO DB writes. Returns a preview
//      token the client uses for the commit step.
//   2. commitArqStatement — look up token, validate ownership, invoke the full
//      runStatementImport pipeline. DB writes happen here.
//
// Preview approach: we call parseArqStatementPdf + reconcileStatement +
// buildChainCheck directly (the pure functions) plus the DB-only queries for
// chain check + account resolution, WITHOUT invoking the persist step inside
// runStatementImport. This avoids adding a dry-run flag to #515's API.
//
// Token cache: in-process Map with per-entry expiry timestamps. TTL = 5 min.
// No persistence — server restart clears all pending previews (acceptable for
// a flow that takes <30s end-to-end). Entries include userId so commitArqStatement
// can reject tokens belonging to other users.
//
// Tenant safety: userId always comes from getSessionUser(). The account_id is
// resolved server-side from the PDF header's accountNumber, never from form
// input. Memory: per-user-table-join-tenant-safety.
//
// Logging: Pino only. Never concat user input into message strings.

import crypto from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, arqStatementImports } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createLogger } from "@/lib/logger";
import { buildChainCheck, reconcileStatement } from "@/lib/ingestion/arq-statement/balance";
import { parseArqStatementPdf } from "@/lib/ingestion/arq-statement/pdf-adapter";
import { parseStatementTransactions } from "@/lib/ingestion/arq-statement/type-handlers";
import { runStatementImport } from "@/lib/ingestion/arq-statement/run-statement-import";

import type { ImportPreviewResult, ImportCommitResult } from "./_types";

const log = createLogger({ module: "imports-arq" });

// ---------------------------------------------------------------------------
// Preview token cache
// ---------------------------------------------------------------------------

const PREVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  userId: number;
  accountId: number;
  pdfBuffer: Buffer;
  pdfHash: string;
  preview: ImportPreviewResult;
  expiresAt: number;
}

// Module-level singleton. Fine for a server action where the process lives for
// the lifetime of the Next.js request handler. Multiple server instances each
// hold their own cache — tokens must be redeemed on the same instance. For
// future scaling, replace with Redis; the interface is identical (get/set/TTL).
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
// Validation helpers
// ---------------------------------------------------------------------------

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

function validatePdfBytes(buf: Buffer): string | null {
  if (buf.byteLength > MAX_PDF_BYTES) {
    return `El archivo supera el límite de 10 MB (${(buf.byteLength / 1_048_576).toFixed(1)} MB).`;
  }
  if (buf.subarray(0, 4).compare(PDF_MAGIC) !== 0) {
    return "El archivo no parece ser un PDF válido.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// previewArqStatement
// ---------------------------------------------------------------------------

export async function previewArqStatement(formData: FormData): Promise<ImportPreviewResult> {
  const session = await getSessionUser();
  const userId = session.id;

  // --- Extract file from FormData ---
  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    log.warn({ event: "arq_preview_no_file", userId }, "no file in FormData");
    throw new Error("No se recibió ningún archivo.");
  }

  const arrayBuf = await file.arrayBuffer();
  const pdfBuffer = Buffer.from(arrayBuf);

  // --- Client + server validation ---
  const validationError = validatePdfBytes(pdfBuffer);
  if (validationError) {
    log.warn(
      { event: "arq_preview_validation_failed", userId, bytes: pdfBuffer.byteLength },
      "pdf validation failed",
    );
    throw new Error(validationError);
  }

  // --- Compute SHA-256 hash ---
  const pdfHash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

  // --- Idempotency: check if already imported ---
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

  // --- Parse PDF ---
  let rawStatement;
  try {
    rawStatement = await parseArqStatementPdf(pdfBuffer);
  } catch (err) {
    log.error({ err, event: "arq_preview_parse_failed", userId }, "pdf parse failed");
    throw new Error("No se pudo leer el PDF. Verificá que sea un extracto ARQ válido.");
  }

  // --- Resolve account from accountNumber in header ---
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

  // ARQ account numbers are stored in account.name or metadata. We match by
  // checking the account number appears in the metadata.accountNumber field or
  // the account institution is "ARQ" / "DolarApp".
  // Strategy: find account whose metadata.accountNumber matches, or if not
  // available, any ARQ-currency account. Fallback: reject.
  const matchedAccount = userAccounts.find((a) => {
    const meta = a.metadata as Record<string, unknown> | null;
    if (meta?.accountNumber && String(meta.accountNumber) === accountNumber) return true;
    if (meta?.routingNumber) return true; // ARQ-specific field
    // Heuristic: institution starts with "ARQ" or "DolarApp"
    if (a.institution && /arq|dolarapp/i.test(a.institution)) return true;
    return false;
  });

  if (!matchedAccount) {
    log.warn(
      {
        event: "arq_preview_account_mismatch",
        userId,
        accountNumber,
      },
      "no matching account found for statement accountNumber",
    );
    throw new Error(
      "Este extracto no corresponde a ninguna cuenta tuya. Verificá que sea el archivo correcto.",
    );
  }

  const accountId = matchedAccount.id;
  const accountLabel = formatAccountLabel(matchedAccount);

  // --- Pure reconciliation (no DB writes) ---
  const parsedTxs = parseStatementTransactions(rawStatement);
  const reconcile = reconcileStatement(rawStatement, parsedTxs);

  // Chain check requires a DB read (find prior import) but no writes.
  // We replicate the query from runStatementImport to avoid a "dry-run" flag.
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

  // Estimate how many txs may merge with email (rough heuristic: non-skip count;
  // a real dry-run would require a full reconciler pass against the DB).
  const activeTxCount = parsedTxs.filter((tx) => tx.kind !== "skip").length;

  // --- Build preview result ---
  const preview: ImportPreviewResult = {
    token: "", // filled below after storing
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
    mergePreview: {
      parsedCount: activeTxCount,
      estimatedMergeCount: 0, // real count only available after commit
    },
    errors: reconcile.errors,
  };

  // --- Store in cache ---
  evictExpired();
  const token = crypto.randomUUID();
  previewCache.set(token, {
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

// ---------------------------------------------------------------------------
// commitArqStatement
// ---------------------------------------------------------------------------

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

  // Validate token belongs to the requesting user (cross-user token replay attack).
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

  // Remove from cache immediately — single use.
  previewCache.delete(previewToken);

  log.info(
    { event: "arq_commit_start", userId, accountId: entry.accountId, token: previewToken },
    "committing ARQ statement import",
  );

  const result = await runStatementImport(
    { parsePdf: parseArqStatementPdf },
    {
      userId,
      accountId: entry.accountId,
      pdfBuffer: entry.pdfBuffer,
      pdfHash: entry.pdfHash,
    },
  );

  switch (result.status) {
    case "committed":
      log.info(
        {
          event: "arq_commit_done",
          userId,
          importId: result.importId,
          insertedTxCount: result.insertedTxCount,
          mergedTxCount: result.mergedTxCount,
          flaggedTxCount: result.flaggedTxCount,
          emailOrphanCount: result.emailOrphanCount,
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
        period: entry.preview.period,
      };

    case "reconcile_failed":
      log.error(
        { event: "arq_commit_reconcile_failed", userId, importId: result.importId },
        "statement reconciliation failed on commit",
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
        { event: "arq_commit_error", userId, error: result.error },
        "runStatementImport returned error",
      );
      return { status: "error", error: result.error };
  }
}
