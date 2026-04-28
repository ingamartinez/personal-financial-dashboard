// Unified ingestion dispatcher — format detection + parsing façade.
//
// Entry points:
//   detectKind(buffer)         — cheap sniff, returns IngestionKind or
//                                "format_unknown". Never throws (unless file
//                                is neither PDF nor XLSX → UnsupportedFileKindError).
//   parseAndHint(buffer, opts) — detect + parse + derive hints in one call.
//   resolveAccountHint(userId, result) — DB-side helper: finds the user's
//                                account whose metadata matches the parsed
//                                file header. Multi-tenant safe.
//
// Sniff order (design Decision #3 — locked):
//   1. First 4 bytes == "%PDF" magic → arq-pdf
//   2. First 4 bytes == "PK\x03\x04" (XLSX ZIP magic) → XLSX.read, then:
//      a. tryDetectTcDetallado → bancolombia-tc-detallado
//      b. tryDetectFormat     → bancolombia-savings | extracto | tc-legacy
//      c. fall through        → format_unknown (does NOT throw)
//   3. Anything else          → throws UnsupportedFileKindError
//
// File size limits are enforced HERE, before any parse attempt.
//
// Logging: Pino only — import createLogger. Zero console.* calls.
// Multi-tenant: resolveAccountHint always filters by userId. (Memory:
// per-user-table-join-tenant-safety)

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { parseArqStatementPdf } from "./arq-statement/pdf-adapter";
import { tryDetectFormat } from "@/lib/reconciliation/dispatch";
import { tryDetectTcDetallado } from "./bancolombia-statement/xlsx";
import { parseBancolombiaSavings } from "@/lib/reconciliation/parsers/bancolombia-savings";
import { parseBancolombiaSavingsExtracto } from "@/lib/reconciliation/parsers/bancolombia-savings-extracto";
import { parseBancolombiaTc } from "@/lib/reconciliation/parsers/bancolombia-tc";
import { parseBancolombiaStatementAllSheets } from "./bancolombia-statement/xlsx";

import type { AccountHint, CycleHint, DispatchResult, IngestionKind } from "./dispatch-types";

const log = createLogger({ module: "ingestion/dispatch" });

// ---------------------------------------------------------------------------
// File size limits (enforced before any parse attempt)
// ---------------------------------------------------------------------------

const MAX_ARQ_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_XLSX_BYTES = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

/** "%PDF" as a byte pattern */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]);

/** "PK\x03\x04" — ZIP local-file header that XLSX uses */
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// ---------------------------------------------------------------------------
// UnsupportedFileKindError
// ---------------------------------------------------------------------------

export class UnsupportedFileKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileKindError";
  }
}

// ---------------------------------------------------------------------------
// detectKind
// ---------------------------------------------------------------------------

/**
 * Sniff-only detector. Returns IngestionKind or "format_unknown".
 *
 * "format_unknown" means: valid XLSX but no header matched.
 * Throws UnsupportedFileKindError when first 4 bytes are neither PDF nor XLSX.
 */
export function detectKind(buffer: Buffer): IngestionKind | "format_unknown" {
  const magic = buffer.subarray(0, 4);

  // --- Step 1: PDF magic ---
  if (magic.compare(PDF_MAGIC) === 0) {
    return "arq-pdf";
  }

  // --- Step 2: XLSX ZIP magic ---
  if (magic.compare(XLSX_MAGIC) === 0) {
    // a. TC detallado probe (most distinctive structural signature)
    if (tryDetectTcDetallado(buffer)) {
      return "bancolombia-tc-detallado";
    }

    // b. Reconciliation format probe
    const detected = tryDetectFormat(buffer);
    if (detected) {
      switch (detected.format) {
        case "bancolombia_savings":
          return "bancolombia-savings";
        case "bancolombia_savings_extracto":
          return "bancolombia-extracto";
        case "bancolombia_tc":
          return "bancolombia-tc-legacy";
      }
    }

    // c. Fall through — valid XLSX but no format matched
    return "format_unknown";
  }

  // --- Step 3: Unsupported file kind ---
  throw new UnsupportedFileKindError("Tipo de archivo no soportado.");
}

// ---------------------------------------------------------------------------
// parseAndHint
// ---------------------------------------------------------------------------

/**
 * Detect + parse + derive hints in one call. Returns a DispatchResult.
 *
 * File size limits are enforced here before any parse attempt.
 * opts.userId is used only for logging; account resolution happens separately
 * via resolveAccountHint().
 */
export async function parseAndHint(
  buffer: Buffer,
  opts?: { userId?: number },
): Promise<DispatchResult> {
  const userId = opts?.userId;
  const magic = buffer.subarray(0, 4);

  // --- Step 1: PDF ---
  if (magic.compare(PDF_MAGIC) === 0) {
    const mbActual = (buffer.byteLength / 1_048_576).toFixed(1);
    if (buffer.byteLength > MAX_ARQ_PDF_BYTES) {
      log.warn(
        { event: "ingestion_file_too_large", kind: "arq-pdf", bytes: buffer.byteLength, userId },
        "pdf file exceeds size limit",
      );
      throw new UnsupportedFileKindError(
        `El archivo supera el límite de 10 MB (${mbActual} MB actual).`,
      );
    }

    log.debug({ event: "ingestion_parse_start", kind: "arq-pdf", userId }, "parsing arq pdf");
    let rawStatement;
    try {
      rawStatement = await parseArqStatementPdf(buffer);
    } catch (err) {
      log.error({ err, event: "parse_failed", kind: "arq-pdf", userId }, "arq pdf parse failed");
      throw err;
    }

    // Derive accountHint from header.accountNumber — resolved later against DB
    // by resolveAccountHint; here we can only record the raw accountNumber so
    // the caller can pass it to resolveAccountHint.
    // We return null here; the caller must call resolveAccountHint separately.
    return {
      kind: "arq-pdf",
      rawStatement,
      accountHint: null,
    };
  }

  // --- Step 2: XLSX ---
  if (magic.compare(XLSX_MAGIC) === 0) {
    const mbActual = (buffer.byteLength / 1_048_576).toFixed(1);
    if (buffer.byteLength > MAX_XLSX_BYTES) {
      log.warn(
        { event: "ingestion_file_too_large", kind: "xlsx", bytes: buffer.byteLength, userId },
        "xlsx file exceeds size limit",
      );
      throw new UnsupportedFileKindError(
        `El archivo supera el límite de 5 MB (${mbActual} MB actual).`,
      );
    }

    // a. TC detallado
    if (tryDetectTcDetallado(buffer)) {
      log.debug(
        { event: "ingestion_parse_start", kind: "bancolombia-tc-detallado", userId },
        "parsing bancolombia tc detallado",
      );
      let parsedSheets;
      try {
        parsedSheets = parseBancolombiaStatementAllSheets(buffer);
      } catch (err) {
        log.error(
          { err, event: "parse_failed", kind: "bancolombia-tc-detallado", userId },
          "tc detallado parse failed",
        );
        throw err;
      }

      const multiCurrencySheets = parsedSheets.length >= 2;
      const firstSheet = parsedSheets[0];
      // Derive cycleHint from the first (COP) sheet's period start.
      const periodStart = firstSheet?.period.startDate;
      const cycleHint: CycleHint = {
        cycle: periodStart
          ? `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, "0")}`
          : "",
        source: "file-period",
      };

      return {
        kind: "bancolombia-tc-detallado",
        parsedSheets,
        multiCurrencySheets,
        cycleHint,
        accountHint: null,
      };
    }

    // b. Reconciliation format probe
    const detected = tryDetectFormat(buffer);
    if (detected) {
      if (detected.format === "bancolombia_savings") {
        log.debug(
          { event: "ingestion_parse_start", kind: "bancolombia-savings", userId },
          "parsing bancolombia savings",
        );
        let parsed;
        try {
          parsed = parseBancolombiaSavings(buffer);
        } catch (err) {
          log.error(
            { err, event: "parse_failed", kind: "bancolombia-savings", userId },
            "bancolombia savings parse failed",
          );
          throw err;
        }
        return { kind: "bancolombia-savings", parsed, accountHint: null };
      }

      if (detected.format === "bancolombia_savings_extracto") {
        log.debug(
          { event: "ingestion_parse_start", kind: "bancolombia-extracto", userId },
          "parsing bancolombia extracto mensual",
        );
        let parsed;
        try {
          parsed = parseBancolombiaSavingsExtracto(buffer);
        } catch (err) {
          log.error(
            { err, event: "parse_failed", kind: "bancolombia-extracto", userId },
            "bancolombia extracto parse failed",
          );
          throw err;
        }
        return { kind: "bancolombia-extracto", parsed, accountHint: null };
      }

      if (detected.format === "bancolombia_tc") {
        log.debug(
          { event: "ingestion_parse_start", kind: "bancolombia-tc-legacy", userId },
          "parsing bancolombia tc legacy",
        );
        let parsed;
        try {
          parsed = parseBancolombiaTc(buffer);
        } catch (err) {
          log.error(
            { err, event: "parse_failed", kind: "bancolombia-tc-legacy", userId },
            "bancolombia tc legacy parse failed",
          );
          throw err;
        }
        return { kind: "bancolombia-tc-legacy", parsed, accountHint: null };
      }
    }

    // c. Fall through — valid XLSX but no format matched
    log.info({ event: "ingestion_format_unknown", userId }, "xlsx did not match any known format");
    return { kind: "format_unknown" };
  }

  // --- Step 3: Unsupported ---
  log.warn(
    {
      event: "ingestion_unsupported_file_kind",
      userId,
      magicHex: magic.toString("hex"),
    },
    "unsupported file kind",
  );
  throw new UnsupportedFileKindError("Tipo de archivo no soportado.");
}

// ---------------------------------------------------------------------------
// resolveAccountHint
// ---------------------------------------------------------------------------

/**
 * Resolves the user's account that matches the parsed file's header metadata.
 *
 * Multi-tenant safe: ALWAYS filters `accounts.userId = userId` (query #1
 * first — memory: per-user-table-join-tenant-safety). Returns null (does NOT
 * throw) when no match is found so the caller can fall through to manual picker.
 *
 * Matching strategy per kind:
 *   arq-pdf              → `metadata.accountNumber` OR institution heuristic
 *                          (matches accounts.institution ILIKE arq/dolarapp).
 *   bancolombia-savings  → `metadata.last4s` contains parsed account's last4.
 *   bancolombia-extracto → same as savings.
 *   bancolombia-tc-legacy→ same as savings.
 *   bancolombia-tc-detallado → `metadata.last4s` contains the COP sheet's
 *                          card last4.
 *   format_unknown       → always returns null.
 */
export async function resolveAccountHint(
  userId: number,
  result: DispatchResult,
): Promise<AccountHint | null> {
  if (result.kind === "format_unknown") return null;

  // Fetch all non-deleted accounts for this user (single query #1 — tenant-safe).
  const userAccounts = await db
    .select({
      id: accounts.id,
      institution: accounts.institution,
      metadata: accounts.metadata,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)));

  if (result.kind === "arq-pdf") {
    const accountNumber = result.rawStatement.header.accountNumber;
    const match = userAccounts.find((a) => {
      const meta = a.metadata as Record<string, unknown> | null;
      if (meta?.accountNumber && String(meta.accountNumber) === accountNumber) return true;
      if (meta?.routingNumber) return true; // ARQ-specific marker
      if (a.institution && /arq|dolarapp/i.test(a.institution)) return true;
      return false;
    });
    if (!match) {
      log.info(
        { event: "account_hint_not_resolved", kind: "arq-pdf", userId, accountNumber },
        "no account matched arq accountNumber",
      );
      return null;
    }
    return { accountId: match.id, source: "file-header" };
  }

  if (
    result.kind === "bancolombia-savings" ||
    result.kind === "bancolombia-extracto" ||
    result.kind === "bancolombia-tc-legacy"
  ) {
    // The reconciliation ParsedStatement doesn't carry a last4 directly —
    // those parsers don't extract account metadata from the XLSX. Account
    // resolution for these kinds relies on the query-string hint from the
    // calling page. Return null to let the UI fall back to manual picker.
    log.debug(
      { event: "account_hint_not_resolved_savings", kind: result.kind, userId },
      "savings/extracto/tc-legacy account hint requires url query-string; returning null",
    );
    return null;
  }

  if (result.kind === "bancolombia-tc-detallado") {
    const firstSheet = result.parsedSheets[0];
    if (!firstSheet) return null;
    const last4 = firstSheet.account.last4;
    const match = userAccounts.find((a) => {
      const meta = a.metadata as Record<string, unknown> | null;
      const last4s = (meta?.last4s as string[] | undefined) ?? [];
      return last4s.includes(last4);
    });
    if (!match) {
      log.info(
        { event: "account_hint_not_resolved", kind: "bancolombia-tc-detallado", userId, last4 },
        "no account matched tc detallado card last4",
      );
      return null;
    }
    return { accountId: match.id, source: "file-header" };
  }

  return null;
}
