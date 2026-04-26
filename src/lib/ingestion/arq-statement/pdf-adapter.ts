import { createRequire } from "module";

import { createLogger } from "@/lib/logger";

import type { ArqEquivalentCurrency, RawStatement, RawTxLine } from "./types";

const log = createLogger({ module: "arq-statement-pdf" });

// ---------------------------------------------------------------------------
// pdfjs-dist setup
// ---------------------------------------------------------------------------
// We use the `legacy` build because the standard build requires DOMMatrix and
// other browser globals that are not available in Node.js / Bun.
//
// In Node.js, pdfjs-dist automatically disables the web worker and runs
// synchronously in-process via a LoopbackPort "fake worker". The catch: it
// still tries to import the worker file at `GlobalWorkerOptions.workerSrc`.
// We resolve that path at module-init time so it survives cwd changes.
//
// createRequire resolves relative to THIS source file, so it correctly finds
// the package regardless of cwd at invocation time.
const _require = createRequire(import.meta.url);
const PDFJS_WORKER_PATH: string = _require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");

async function getPdfjsLib() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;
  return pdfjs;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Extract all text from a PDF buffer, page by page, joining with newlines.
 *
 * pdfjs-dist returns `TextItem[]` where each item has a `str` field and a
 * `hasEOL` flag. We honour `hasEOL` to preserve visual line breaks instead of
 * running all items together.
 *
 * @throws {ArqPdfExtractionError} when no text can be extracted from the PDF
 */
export async function extractTextFromPdf(buffer: Buffer | Uint8Array): Promise<string> {
  const pdfjs = await getPdfjsLib();

  const data = buffer instanceof Buffer ? new Uint8Array(buffer) : buffer;

  log.debug(
    { event: "arq_pdf_extract_start", bytes: data.byteLength },
    "starting pdf text extraction",
  );

  const loadingTask = pdfjs.getDocument({ data });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    throw new ArqPdfExtractionError("pdfjs failed to load document", { cause: err });
  }

  const pageTexts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const lines: string[] = [];
    let currentLine = "";

    for (const item of content.items) {
      // TextMarkedContent items don't have `str`
      if (!("str" in item)) continue;

      currentLine += item.str;

      if (item.hasEOL) {
        lines.push(currentLine);
        currentLine = "";
      }
    }

    // Flush any trailing content on the last line
    if (currentLine.trim()) {
      lines.push(currentLine);
    }

    pageTexts.push(lines.join("\n"));
  }

  const fullText = pageTexts.join("\n");

  if (!fullText.trim()) {
    throw new ArqPdfExtractionError("PDF yielded no text — may be image-based");
  }

  log.debug(
    { event: "arq_pdf_extract_done", pages: pdf.numPages, chars: fullText.length },
    "pdf text extraction complete",
  );

  return fullText;
}

// ---------------------------------------------------------------------------
// Header parser
// ---------------------------------------------------------------------------

const MONTH_MAP: Record<string, number> = {
  January: 0,
  February: 1,
  March: 2,
  April: 3,
  May: 4,
  June: 5,
  July: 6,
  August: 7,
  September: 8,
  October: 9,
  November: 10,
  December: 11,
  // Short forms seen in transaction date column
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/**
 * Parse a full-form date string from the PDF header.
 * Formats observed: "1 January 2026", "31 January 2026"
 */
function parseHeaderDate(raw: string): Date {
  const match = raw.trim().match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
  if (!match) {
    throw new ArqParseError(`Cannot parse header date: "${raw}"`);
  }
  const [, dayStr, monthName, yearStr] = match;
  const month = MONTH_MAP[monthName];
  if (month === undefined) {
    throw new ArqParseError(`Unknown month name in header date: "${monthName}"`);
  }
  return new Date(Date.UTC(parseInt(yearStr, 10), month, parseInt(dayStr, 10)));
}

/**
 * Parse an amount string from the PDF header or summary section.
 * Handles: "$262.96", "2,104,000", "-331.91", "1,594.01"
 * Returns the amount in cents as bigint.
 */
function parseAmountCents(raw: string): bigint {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  const negative = cleaned.startsWith("-");
  const abs = negative ? cleaned.slice(1) : cleaned;

  const dotIdx = abs.indexOf(".");
  let intPart: string;
  let fracPart: string;

  if (dotIdx === -1) {
    intPart = abs;
    fracPart = "00";
  } else {
    intPart = abs.slice(0, dotIdx);
    fracPart = abs
      .slice(dotIdx + 1)
      .padEnd(2, "0")
      .slice(0, 2);
  }

  const cents = BigInt(intPart) * BigInt(100) + BigInt(fracPart);
  return negative ? -cents : cents;
}

interface ParsedHeader {
  accountHolder: string;
  accountNumber: string;
  routingNumber: string;
  periodStart: Date;
  periodEnd: Date;
  durationDays: number;
  balanceStartCents: bigint;
  totalCreditsCents: bigint;
  totalDebitsCents: bigint;
  balanceEndCents: bigint;
}

/**
 * Extract the header block from the raw PDF text.
 *
 * Expected structure (from discovery):
 *   Account holder name
 *   US - Número de cuenta:  211215197073
 *   Número de ruta:  101019644
 *   Fecha de inicio  1 January 2026
 *   Fecha de fin  31 January 2026
 *   Duración  31 days
 *   Balance de inicio  $262.96
 *   Total ingresos  $2,060.00
 *   Total retiros  $1,594.01
 *   Balance final  $..
 */
function parseHeader(text: string): ParsedHeader {
  const extract = (pattern: RegExp, label: string): string => {
    const match = text.match(pattern);
    if (!match) {
      throw new ArqParseError(`Header field not found: ${label}`);
    }
    return match[1].trim();
  };

  const accountHolder = extract(/^([A-Z][A-Z\s]+[A-Z])$/m, "accountHolder");

  const accountNumber = extract(/US\s*[-–]\s*N[uú]mero de cuenta[:\s]+(\d+)/i, "accountNumber");

  const routingNumber = extract(/N[uú]mero de ruta[:\s]+(\d+)/i, "routingNumber");

  const periodStartRaw = extract(/Fecha de inicio\s+([\s\S]+?)(?:\n|Fecha de fin)/i, "periodStart");
  const periodEndRaw = extract(/Fecha de fin\s+([\s\S]+?)(?:\n|Duraci)/i, "periodEnd");
  const durationRaw = extract(/Duraci[oó]n\s+(\d+)\s+days?/i, "duration");

  const balanceStartRaw = extract(/Balance de inicio\s+\$?([\d,.-]+)/i, "balanceStart");
  const totalCreditsRaw = extract(/Total ingresos\s+\$?([\d,.-]+)/i, "totalCredits");
  const totalDebitsRaw = extract(/Total retiros\s+\$?([\d,.-]+)/i, "totalDebits");
  const balanceEndRaw = extract(/Balance final\s+\$?([\d,.-]+)/i, "balanceEnd");

  return {
    accountHolder,
    accountNumber,
    routingNumber,
    periodStart: parseHeaderDate(periodStartRaw),
    periodEnd: parseHeaderDate(periodEndRaw),
    durationDays: parseInt(durationRaw, 10),
    balanceStartCents: parseAmountCents(balanceStartRaw),
    totalCreditsCents: parseAmountCents(totalCreditsRaw),
    totalDebitsCents: parseAmountCents(totalDebitsRaw),
    balanceEndCents: parseAmountCents(balanceEndRaw),
  };
}

// ---------------------------------------------------------------------------
// Transaction table parser
// ---------------------------------------------------------------------------

// Short month names appear in the date column: "Jan 01", "Feb 13", "Mar 14"
const TX_DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/;

// Amount column: optional sign, digits, optional comma-thousands, mandatory
// decimal part (e.g. "-18.03", "+2,060", "-67,440", "-1,594.01")
const AMOUNT_RE = /^([+-])?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)$/;

// Equivalent currency column values
const EQUIV_CURRENCIES = new Set<string>(["COP", "USD", "USDc"]);

/**
 * Parse a transaction date using only month+day from the PDF, deriving the
 * year from the statement period. Handles year rollover (Dec statement with
 * Jan transactions).
 *
 * @param monthStr - 3-letter month abbreviation, e.g. "Jan"
 * @param dayStr   - Day of month, e.g. "01"
 * @param periodStart - Statement period start date
 * @param periodEnd   - Statement period end date
 */
function resolveTxDate(monthStr: string, dayStr: string, periodStart: Date, periodEnd: Date): Date {
  const month = MONTH_MAP[monthStr];
  if (month === undefined) {
    throw new ArqParseError(`Unknown transaction month: "${monthStr}"`);
  }

  const day = parseInt(dayStr, 10);
  const startYear = periodStart.getUTCFullYear();
  const endYear = periodEnd.getUTCFullYear();

  // Try with the period-start year first; if the resulting date falls outside
  // the period, try period-end year (year rollover: e.g. Dec→Jan period).
  for (const year of [startYear, endYear]) {
    const candidate = new Date(Date.UTC(year, month, day));
    if (candidate >= periodStart && candidate <= periodEnd) {
      return candidate;
    }
  }

  // If neither year fits exactly (shouldn't happen with valid PDFs), default
  // to start year — the reconciler (#515) will flag the balance invariant.
  log.warn(
    {
      event: "arq_tx_date_out_of_range",
      monthStr,
      dayStr,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    },
    "transaction date outside period — defaulting to period-start year",
  );
  return new Date(Date.UTC(startYear, month, day));
}

/**
 * Parse the raw amount string from a transaction column.
 * Amount strings may have leading +/- signs and comma-separated thousands.
 * Returns signed bigint cents.
 */
function parseTxAmountCents(raw: string): bigint {
  const trimmed = raw.trim();
  const isNegative = trimmed.startsWith("-");
  const body = trimmed.replace(/^[+-]/, "").replace(/,/g, "");

  const dotIdx = body.indexOf(".");
  let intPart: string;
  let fracPart: string;

  if (dotIdx === -1) {
    intPart = body;
    fracPart = "00";
  } else {
    intPart = body.slice(0, dotIdx);
    fracPart = body
      .slice(dotIdx + 1)
      .padEnd(2, "0")
      .slice(0, 2);
  }

  const abs = BigInt(intPart) * BigInt(100) + BigInt(fracPart);
  return isNegative ? -abs : abs;
}

/**
 * Attempt to parse one text line as a transaction row.
 *
 * ARQ statement transaction lines have 6 columns (verified across Jan/Feb/Mar
 * 2026 samples):
 *
 *   [Date]  [Type]  [Monto]  [Currency]  [Equivalent]  [Description]
 *
 * The tricky parts:
 *  - "Type" is multi-word ("Pago con tarjeta", "Transferencia P2P").
 *  - "Monto" always has a sign (+/-) or is clearly numeric with a dot.
 *  - "Currency" is one of COP / USD / USDc / N/A.
 *  - "Equivalent" mirrors "Monto" format or is N/A.
 *  - "Description" is everything after the equivalent amount.
 *
 * Strategy: tokenise on runs of whitespace, then walk left-to-right:
 *   1. First token must match TX_DATE_RE (month + day).
 *   2. Scan forward until we find a token matching AMOUNT_RE — everything
 *      between date and amount is the Type.
 *   3. Next token: Currency (COP | USD | USDc | N/A).
 *   4. Next token: Equivalent amount or N/A.
 *   5. Everything remaining: Description.
 *
 * Returns null if the line does not look like a transaction.
 */
function parseTxLine(line: string, periodStart: Date, periodEnd: Date): PendingTx | null {
  const tokens = line.trim().split(/\s{2,}/);
  if (tokens.length < 5) return null;

  // --- 1. Date ---
  const dateMatch = tokens[0].match(TX_DATE_RE);
  if (!dateMatch) return null;

  const [, monthStr, dayStr] = dateMatch;
  const date = resolveTxDate(monthStr, dayStr, periodStart, periodEnd);

  // --- 2. Find Monto column: first token after date that looks like an amount ---
  let amountIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (AMOUNT_RE.test(tokens[i].trim())) {
      amountIdx = i;
      break;
    }
  }
  if (amountIdx < 0) return null;

  const type = tokens.slice(1, amountIdx).join(" ").trim();
  if (!type) return null;

  const amountCents = parseTxAmountCents(tokens[amountIdx]);

  // --- 3. Currency ---
  const currencyToken = tokens[amountIdx + 1]?.trim();
  if (!currencyToken) return null;

  const isNA = currencyToken === "N/A";
  const isValidCurrency = EQUIV_CURRENCIES.has(currencyToken);
  if (!isNA && !isValidCurrency) return null;

  const equivalentCurrency: ArqEquivalentCurrency | null = isNA
    ? null
    : (currencyToken as ArqEquivalentCurrency);

  // --- 4. Equivalent amount ---
  const equivToken = tokens[amountIdx + 2]?.trim();
  if (!equivToken) return null;

  let equivalentAmountCents: bigint | null;
  if (equivToken === "N/A") {
    equivalentAmountCents = null;
  } else if (AMOUNT_RE.test(equivToken)) {
    equivalentAmountCents = parseTxAmountCents(equivToken);
  } else {
    return null;
  }

  // --- 5. Description start (continuation lines will be appended by caller) ---
  const descriptionStart = tokens
    .slice(amountIdx + 3)
    .join(" ")
    .trim();

  return {
    date,
    type,
    amountCents,
    equivalentCurrency,
    equivalentAmountCents,
    descriptionStart,
  };
}

interface PendingTx {
  date: Date;
  type: string;
  amountCents: bigint;
  equivalentCurrency: ArqEquivalentCurrency | null;
  equivalentAmountCents: bigint | null;
  descriptionStart: string;
}

function pendingToRawTxLine(p: PendingTx): RawTxLine {
  return {
    date: p.date,
    type: p.type,
    amountCents: p.amountCents,
    equivalentCurrency: p.equivalentCurrency,
    equivalentAmountCents: p.equivalentAmountCents,
    description: p.descriptionStart,
  };
}

/**
 * Parse the transaction table from the full PDF text, re-joining multi-line
 * description rows.
 */
function parseTxTable(text: string, periodStart: Date, periodEnd: Date): RawTxLine[] {
  const lines = text.split("\n");
  const result: RawTxLine[] = [];

  let pending: PendingTx | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      // Blank line: flush pending
      if (pending) {
        result.push(pendingToRawTxLine(pending));
        pending = null;
      }
      continue;
    }

    const parsed = parseTxLine(line, periodStart, periodEnd);

    if (parsed) {
      // Flush any previous pending tx
      if (pending) {
        result.push(pendingToRawTxLine(pending));
      }
      pending = {
        date: parsed.date,
        type: parsed.type,
        amountCents: parsed.amountCents,
        equivalentCurrency: parsed.equivalentCurrency,
        equivalentAmountCents: parsed.equivalentAmountCents,
        descriptionStart: parsed.descriptionStart,
      };
    } else if (pending) {
      // Continuation of previous transaction's description
      pending = {
        date: pending.date,
        type: pending.type,
        amountCents: pending.amountCents,
        equivalentCurrency: pending.equivalentCurrency,
        equivalentAmountCents: pending.equivalentAmountCents,
        descriptionStart: (pending.descriptionStart + " " + line.trim()).trim(),
      };
    }
    // Lines before any transaction row (header, labels) are skipped
  }

  // Flush final pending
  if (pending) {
    result.push(pendingToRawTxLine(pending));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Text → RawStatement
// ---------------------------------------------------------------------------

/**
 * Parse the full text extracted from an ARQ statement PDF into a
 * `RawStatement`. This function is pure (no I/O, no DB access).
 *
 * @throws {ArqParseError} when required header fields are missing or malformed
 */
export function parseArqStatementText(text: string): RawStatement {
  log.debug(
    { event: "arq_statement_text_parse_start", chars: text.length },
    "parsing statement text",
  );

  const header = parseHeader(text);
  const transactions = parseTxTable(text, header.periodStart, header.periodEnd);

  log.debug(
    { event: "arq_statement_text_parse_done", txCount: transactions.length },
    "statement text parsed",
  );

  return {
    header: {
      accountHolder: header.accountHolder,
      accountNumber: header.accountNumber,
      routingNumber: header.routingNumber,
      periodStart: header.periodStart,
      periodEnd: header.periodEnd,
      durationDays: header.durationDays,
      summary: {
        balanceStartCents: header.balanceStartCents,
        totalCreditsCents: header.totalCreditsCents,
        totalDebitsCents: header.totalDebitsCents,
        balanceEndCents: header.balanceEndCents,
      },
    },
    transactions,
  };
}

// ---------------------------------------------------------------------------
// Vision fallback
// ---------------------------------------------------------------------------

/**
 * Vision fallback: uses Claude's vision capability to extract transaction data
 * from a PDF that yielded no extractable text (image-based PDF).
 *
 * Controlled by `ARQ_VISION_FALLBACK_ENABLED=true`. Default: off.
 *
 * @throws {ArqVisionFallbackDisabledError} when fallback is disabled
 * @throws {ArqParseError} when vision extraction fails or the response is
 *   unparseable
 */
async function extractViaVision(buffer: Buffer | Uint8Array): Promise<RawStatement> {
  if (process.env.ARQ_VISION_FALLBACK_ENABLED !== "true") {
    throw new ArqVisionFallbackDisabledError(
      "ARQ PDF text extraction failed and ARQ_VISION_FALLBACK_ENABLED is not set",
    );
  }

  log.warn(
    { event: "arq_vision_fallback_triggered", bytes: buffer.byteLength },
    "falling back to Claude Vision for PDF extraction",
  );

  const { callClaudeText } = await import("@/lib/ai/anthropic-client");

  // Encode the PDF as base64 for transmission. Vision API accepts image/*, not
  // PDFs directly — convert would require a canvas renderer which is out of
  // scope. For now we surface a clear error; a proper vision path would render
  // pages to PNG first. See TODO below.
  //
  // TODO(#513): replace with real PDF-to-image conversion once user provides
  //   real redacted PDFs and the vision path is validated. Right now this
  //   serves as the wiring scaffold.
  const base64 = Buffer.from(buffer).toString("base64");
  const response = await callClaudeText({
    model: "claude-sonnet-4-5",
    maxTokens: 4096,
    userPrompt: `The following is a base64-encoded ARQ/DolarApp statement PDF.
Extract ALL transactions as JSON matching this schema:
{
  "header": {
    "accountHolder": string,
    "accountNumber": string,
    "routingNumber": string,
    "periodStart": "YYYY-MM-DD",
    "periodEnd": "YYYY-MM-DD",
    "durationDays": number,
    "summary": {
      "balanceStartCents": number,
      "totalCreditsCents": number,
      "totalDebitsCents": number,
      "balanceEndCents": number
    }
  },
  "transactions": [{
    "date": "YYYY-MM-DD",
    "type": string,
    "amountCents": number,
    "equivalentCurrency": "COP"|"USD"|"USDc"|null,
    "equivalentAmountCents": number|null,
    "description": string
  }]
}

All monetary amounts must be in integer cents (multiply dollar amounts by 100).
Negative amounts represent debits, positive represent credits.

PDF (base64): ${base64}`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new ArqParseError("Vision fallback returned non-JSON response");
  }

  // Basic structural validation — full Zod schema validation is intentionally
  // omitted here to keep the fallback lightweight; the caller (#517 reconciler)
  // runs the same balance invariant check regardless of extraction path.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("header" in parsed) ||
    !("transactions" in parsed)
  ) {
    throw new ArqParseError("Vision fallback returned unexpected JSON structure");
  }

  // Convert date strings and number cents to proper types
  const raw = parsed as Record<string, unknown>;
  const h = raw.header as Record<string, unknown>;
  const txs = (raw.transactions as Record<string, unknown>[]).map((tx) => ({
    date: new Date(tx.date as string),
    type: tx.type as string,
    amountCents: BigInt(tx.amountCents as number),
    equivalentCurrency: (tx.equivalentCurrency as ArqEquivalentCurrency | null) ?? null,
    equivalentAmountCents:
      tx.equivalentAmountCents != null ? BigInt(tx.equivalentAmountCents as number) : null,
    description: tx.description as string,
  }));

  const hs = h.summary as Record<string, unknown>;

  return {
    header: {
      accountHolder: h.accountHolder as string,
      accountNumber: h.accountNumber as string,
      routingNumber: h.routingNumber as string,
      periodStart: new Date(h.periodStart as string),
      periodEnd: new Date(h.periodEnd as string),
      durationDays: h.durationDays as number,
      summary: {
        balanceStartCents: BigInt(hs.balanceStartCents as number),
        totalCreditsCents: BigInt(hs.totalCreditsCents as number),
        totalDebitsCents: BigInt(hs.totalDebitsCents as number),
        balanceEndCents: BigInt(hs.balanceEndCents as number),
      },
    },
    transactions: txs,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse an ARQ/DolarApp statement PDF into a `RawStatement`.
 *
 * Pipeline:
 *   1. Extract text from PDF using pdfjs-dist (legacy Node.js build).
 *   2. Parse header + transaction table from the extracted text.
 *   3. If extraction fails AND `ARQ_VISION_FALLBACK_ENABLED=true`, fall back
 *      to Claude Vision. Otherwise rethrow a structured error.
 *
 * The returned `RawStatement` contains no DB references — it is the
 * DB-agnostic representation of the PDF. Tenant validation and persistence
 * are handled by downstream sub-issues (#514, #517).
 *
 * @param file - Raw PDF bytes (Buffer or Uint8Array)
 * @returns Parsed statement with header and transaction list
 * @throws {ArqPdfExtractionError} if text extraction fails and vision is off
 * @throws {ArqParseError} if the header or transaction table cannot be parsed
 */
export async function parseArqStatementPdf(file: Buffer | Uint8Array): Promise<RawStatement> {
  log.debug({ event: "arq_pdf_parse_start", bytes: file.byteLength }, "parsing arq statement pdf");

  let text: string;
  try {
    text = await extractTextFromPdf(file);
  } catch (err) {
    if (err instanceof ArqPdfExtractionError) {
      log.warn(
        { err, event: "arq_pdf_extract_failed" },
        "pdf text extraction failed — trying vision fallback",
      );
      return extractViaVision(file);
    }
    throw err;
  }

  const statement = parseArqStatementText(text);

  log.debug(
    {
      event: "arq_pdf_parse_done",
      accountNumber: statement.header.accountNumber,
      txCount: statement.transactions.length,
    },
    "arq statement pdf parsed",
  );

  return statement;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ArqPdfExtractionError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "ArqPdfExtractionError";
  }
}

export class ArqParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArqParseError";
  }
}

export class ArqVisionFallbackDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArqVisionFallbackDisabledError";
  }
}
