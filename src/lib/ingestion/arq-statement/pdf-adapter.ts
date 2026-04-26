import { createRequire } from "module";

import { createLogger } from "@/lib/logger";

import type { ArqEquivalentCurrency, RawStatement, RawTxLine } from "./types";

// ---------------------------------------------------------------------------
// pdfjs-dist browser-globals shim — MUST run before any code path that may
// load the pdfjs-dist module graph. Turbopack/Next standalone evaluate
// dynamic imports eagerly when bundling for Server Components, so installing
// the shim inside the loader function is too late under Turbopack.
//
// pdfjs-dist's legacy build still references DOMMatrix / Path2D / ImageData
// at module-evaluation time (used by canvas rendering paths we never hit).
// Stub classes are sufficient because we only extract text — never render.
//
// In jsdom (test) these globals exist natively, which is why tests passed
// while production crashed on the first PDF upload.
// ---------------------------------------------------------------------------
{
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    class StubDOMMatrix {
      constructor() {}
      multiplySelf() {
        return this;
      }
      multiply() {
        return this;
      }
      invertSelf() {
        return this;
      }
      translateSelf() {
        return this;
      }
      scaleSelf() {
        return this;
      }
    }
    g.DOMMatrix = StubDOMMatrix;
  }
  if (typeof g.Path2D === "undefined") {
    class StubPath2D {
      constructor() {}
      addPath() {}
      moveTo() {}
      lineTo() {}
      closePath() {}
    }
    g.Path2D = StubPath2D;
  }
  if (typeof g.ImageData === "undefined") {
    class StubImageData {
      constructor() {}
    }
    g.ImageData = StubImageData;
  }
}

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
// the package in pure Node + Bun. Under Next.js standalone + Turbopack,
// `import.meta.url` points at the bundled chunk and the resolution may fail —
// fall back to an empty string so pdfjs's type check passes. In Node, pdfjs
// uses an in-process LoopbackPort fake worker regardless of workerSrc value,
// so the actual path is irrelevant for our text-only extraction path.
function resolvePdfjsWorkerPath(): string {
  try {
    const _require = createRequire(import.meta.url);
    const resolved: unknown = _require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    return typeof resolved === "string" ? resolved : "";
  } catch {
    // Turbopack may stub createRequire entirely or have it throw under the
    // bundled standalone runtime — fall back to empty string.
    return "";
  }
}
const PDFJS_WORKER_PATH: string = resolvePdfjsWorkerPath();

async function getPdfjsLib() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs's setter rejects non-string assignments with "Invalid workerSrc type".
  // resolvePdfjsWorkerPath() guarantees a string return.
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
 * Real ARQ statements (Jan/Feb/Mar 2026) use a multi-column PDF layout where
 * pdfjs extracts labels and values into separate runs of lines:
 *
 *   ALEJANDRO RAFAEL MARTINEZ
 *   MALDONADO
 *   US - Número de cuenta: 211215197073
 *   US - Número de ruteo: 101019644
 *   Fechas de Estado de Cuenta
 *   Detalle de
 *   Transacciones
 *   ...
 *   Fecha Tipo Monto Moneda Local Equivalente Monto Local Equivalente Descripción
 *   <transaction rows>
 *   ...
 *   Fecha de inicio
 *   Fecha de fin
 *   Duración
 *   1 January 2026
 *   31 January 2026
 *   (31 Días)
 *   Resumen de Cuenta
 *   Balance de inicio
 *   Ingresos
 *   Retiros
 *   Balance Final
 *   $ 2,542.46
 *   $ 4,170.00
 *   $ 6,449.50
 *   $ 262.96
 *
 * The parser handles two block-style label/value layouts:
 *   - period: 3 labels (Fecha de inicio / Fecha de fin / Duración) followed
 *     by 3 values (date / date / "(N Días)")
 *   - summary: 4 labels (Balance de inicio / Ingresos / Retiros / Balance Final)
 *     followed by 4 dollar amounts.
 */
function parseHeader(text: string): ParsedHeader {
  const extract = (pattern: RegExp, label: string): string => {
    const match = text.match(pattern);
    if (!match) {
      throw new ArqParseError(`Header field not found: ${label}`);
    }
    return match[1].trim();
  };

  const accountHolderRaw = extract(/^([A-Z][A-Z\s]+[A-Z])$/m, "accountHolder");
  // Real PDFs split long names across two lines (e.g. "MARTINEZ\nMALDONADO").
  // The /m anchored regex captures only the first segment; if a second uppercase
  // line follows, take it too.
  const holderTailMatch = text.match(
    new RegExp(
      `^${accountHolderRaw.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\n([A-Z][A-Z\\s]+[A-Z])\\s*\\n`,
      "m",
    ),
  );
  const accountHolder = (
    holderTailMatch ? `${accountHolderRaw} ${holderTailMatch[1].trim()}` : accountHolderRaw
  ).replace(/\s+/g, " ");

  const accountNumber = extract(/US\s*[-–]\s*N[uú]mero de cuenta[:\s]+(\d+)/i, "accountNumber");

  // ARQ writes "Número de ruteo" (with -o), not "ruta". Accept both.
  const routingNumber = extract(/N[uú]mero de rute[ao][:\s]+(\d+)/i, "routingNumber");

  // The period values block: two dates and "(N Días)" appear IMMEDIATELY
  // before "Resumen de Cuenta". The labels (Fecha de inicio / Fecha de fin /
  // Duración) appear much earlier — pdfjs interleaves the label column and
  // value column with the entire transaction table between them. Anchoring on
  // "Resumen de Cuenta" is the only reliable way to locate the values.
  //
  // pdfjs sometimes splits a date across line breaks (e.g. "28 February\n2026"
  // vs "31 January 2026" on one line). To tolerate both, capture the freeform
  // text segment that precedes "(N Días)\nResumen de Cuenta" and re-extract the
  // two dates from inside, collapsing internal whitespace.
  const periodValuesBlock = text.match(
    /([\s\S]+?)\(\s*(\d+)\s*[Dd][ií]as?\s*\)\s*\n\s*Resumen de Cuenta/,
  );
  if (!periodValuesBlock) {
    throw new ArqParseError(
      "Header field not found: period values block before 'Resumen de Cuenta'",
    );
  }
  const segment = periodValuesBlock[1].replace(/\s+/g, " ").trim();
  const dateMatches = [...segment.matchAll(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/g)];
  if (dateMatches.length < 2) {
    throw new ArqParseError(
      `Header field not found: two period dates before "(N Días)" — segment="${segment.slice(-200)}"`,
    );
  }
  // The last two date matches in the segment are periodStart and periodEnd.
  const [startMatch, endMatch] = dateMatches.slice(-2);
  const periodStartRaw = `${startMatch[1]} ${startMatch[2]} ${startMatch[3]}`;
  const periodEndRaw = `${endMatch[1]} ${endMatch[2]} ${endMatch[3]}`;
  const durationRaw = periodValuesBlock[2];

  // Summary block: anchored on "Resumen de Cuenta" header, then 4 labels
  // (Balance de inicio / Ingresos / Retiros / Balance Final) and 4 dollar
  // values in two consecutive runs.
  const summaryBlock = text.match(
    /Resumen de Cuenta\s*\n\s*Balance de inicio\s*\n\s*Ingresos\s*\n\s*Retiros\s*\n\s*Balance Final\s*\n\s*\$?\s*([\d,.-]+)\s*\n\s*\$?\s*([\d,.-]+)\s*\n\s*\$?\s*([\d,.-]+)\s*\n\s*\$?\s*([\d,.-]+)/i,
  );
  if (!summaryBlock) {
    throw new ArqParseError(
      "Header field not found: summary block (Balance de inicio / Ingresos / Retiros / Balance Final)",
    );
  }
  const balanceStartRaw = summaryBlock[1];
  const totalCreditsRaw = summaryBlock[2];
  const totalDebitsRaw = summaryBlock[3];
  const balanceEndRaw = summaryBlock[4];

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

// Equivalent currency column values
const EQUIV_CURRENCIES = new Set<string>(["COP", "USD", "USDc"]);

/**
 * Whole-line regex for a single transaction row in the real ARQ statement PDF.
 *
 * Real text shape (single-space separated, sign and number are SEPARATE tokens):
 *
 *   Jan 01 Pago con tarjeta - 18.03 COP - 67,440 TIENDA D1 BODEGA ESTRE
 *   Jan 13 Compra USDc + 2,060 USD + 2,060 CODEBRANCH LLC
 *   Jan 12 Comisión - 6.99 N/A N/A DolarApp subscription
 *   Feb 12 Cashback + 32.48 USDc + 32.48 Cashback
 *   Feb 28 Beneficio + 6.48 N/A N/A Pago beneficio mensual
 *
 * The 7 known type strings are alternated in the regex — anything else on a
 * line that starts with a date is treated as not-a-tx (parser returns null).
 *
 * Number format: signed (with space between sign and digits), comma-thousands,
 * up to 2 decimals.
 */
const TX_LINE_RE =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(Pago con tarjeta|Compra USDc|Venta USDc|Transferencia P2P|Comisi[oó]n|Cashback|Beneficio)\s+([+-])\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s+(COP|USD|USDc|N\/A)\s+(?:N\/A|([+-])\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?))\s+(.+)$/;

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
  const trimmed = line.trim();

  // Whole-line regex match: date + type + signed-amount + currency +
  // (signed-equiv | N/A) + description.
  const m = trimmed.match(TX_LINE_RE);
  if (!m) return null;

  const [, monthStr, dayStr, typeRaw, sign, amountBody, currencyTok, eqSign, eqBody, descStart] = m;

  const date = resolveTxDate(monthStr, dayStr, periodStart, periodEnd);

  // Normalise the type: strip accents on Comisión so downstream handlers can
  // match a single canonical string. The other types are accent-free already.
  const type = typeRaw === "Comisión" ? "Comisión" : typeRaw;

  // Reassemble the signed amount as one token, then parse via the existing
  // helper. parseTxAmountCents accepts the "<sign><body>" form.
  const amountCents = parseTxAmountCents(`${sign}${amountBody}`);

  let equivalentCurrency: ArqEquivalentCurrency | null;
  let equivalentAmountCents: bigint | null;

  if (currencyTok === "N/A") {
    equivalentCurrency = null;
    equivalentAmountCents = null;
  } else if (EQUIV_CURRENCIES.has(currencyTok)) {
    equivalentCurrency = currencyTok as ArqEquivalentCurrency;
    if (eqSign === undefined || eqBody === undefined) {
      // Equivalent slot was the literal "N/A" — currency exists but no value.
      equivalentAmountCents = null;
    } else {
      equivalentAmountCents = parseTxAmountCents(`${eqSign}${eqBody}`);
    }
  } else {
    return null;
  }

  return {
    date,
    type,
    amountCents,
    equivalentCurrency,
    equivalentAmountCents,
    descriptionStart: descStart.trim(),
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
 * Patterns for lines that look like document furniture rather than a real
 * transaction-description continuation. The PDF layout is multi-page: the
 * period values + summary block appears at the end of page 1, but txs
 * continue on pages 2-N. Cutting the table at "Resumen de Cuenta" would
 * truncate to ~20 txs instead of the real ~80-110.
 *
 * Instead, the parser keeps walking lines and *rejects* concatenation when
 * a line matches one of these "definitely not a description" patterns:
 *   - bare period dates  ("1 January 2026")
 *   - duration parens     ("(31 Días)")
 *   - summary header      ("Resumen de Cuenta")
 *   - dollar values       ("$ 2,542.46")
 *   - column header words ("Fecha Tipo Monto", "Moneda", "Local", etc)
 *   - page footers        ("Si necesita ayuda...", "Página N de M")
 *   - corporate footer    ("DÓLARAPP MÉXICO...", phone/address fragments)
 *   - balance/section labels ("Balance de inicio", "Ingresos", "Retiros", "Balance Final")
 */
const NON_DESCRIPTION_PATTERNS: RegExp[] = [
  /^\d{1,2}\s+\w+\s+\d{4}$/,
  /^\(\s*\d+\s*[Dd][ií]as?\s*\)$/,
  /^Resumen de Cuenta$/i,
  /^Balance (?:de inicio|Final)$/i,
  /^Ingresos$/i,
  /^Retiros$/i,
  /^\$\s*[\d,.-]+$/,
  /^Fecha\b/i,
  /^Moneda$/i,
  /^Local$/i,
  /^Equivalente(?:\s+Descripci[oó]n)?$/i,
  /^Monto(?:\s+Local)?$/i,
  /^Si necesita ayuda/i,
  /^Página \d+ de \d+/i,
  /^Generado el /i,
  /^D[oóÓ]LARAPP /i,
  /^\+\d/,
  /^Colombia$/i,
  /^M[eé]xico$/i,
  /^Fechas de Estado de Cuenta$/i,
  /^Detalle de$/i,
  /^Transacciones$/i,
];

function isObviouslyNotDescription(line: string): boolean {
  const trimmed = line.trim();
  return NON_DESCRIPTION_PATTERNS.some((re) => re.test(trimmed));
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
      // Continuation of the previous transaction's description ONLY if the
      // line is plausibly a description fragment. Document furniture (period
      // dates, summary, page footers, column headers) gets flushed and
      // discarded — pdfjs interleaves these between txs across page breaks.
      if (isObviouslyNotDescription(line)) {
        result.push(pendingToRawTxLine(pending));
        pending = null;
        continue;
      }
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
