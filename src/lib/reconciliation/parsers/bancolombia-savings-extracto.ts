import * as XLSX from "xlsx";
import { StatementParseError, type ParsedStatement, type ParsedStatementRow } from "./types";

/**
 * Column header (normalized to uppercase) for the Bancolombia "Extracto Mensual"
 * savings format. The header lives at ~row 15, not row 1.
 */
const EXTRACTO_HEADERS = ["FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO"] as const;

/**
 * Sentinel row that marks the end of data in the Extracto format.
 * When FECHA is null and DESCRIPCIÓN equals this value, stop scanning.
 */
const END_SENTINEL = "FIN ESTADO DE CUENTA";

/**
 * Parses a Bancolombia savings-account "Extracto Mensual" statement
 * (format B — 6 columns with running SALDO balance).
 *
 * Layout:
 *   Row 1     blank
 *   Row 2     "Información Cliente:"
 *   Row 3     CLIENTE | DIRECCIÓN | CIUDAD (label row)
 *   Row 4     <customer data>
 *   Row 5     blank
 *   Row 6     "Información General:"
 *   Row 7     DESDE | HASTA | TIPO CUENTA | NRO CUENTA | SUCURSAL (label row)
 *   Row 8     <period data: e.g. "2025/12/31" | "2026/03/31" | ...>
 *   Row 9     blank
 *   Row 10    "Resumen:"
 *   Row 11-12 summary labels + values
 *   Row 13    blank
 *   Row 14    "Movimientos:"
 *   Row 15    FECHA | DESCRIPCIÓN | SUCURSAL | DCTO. | VALOR | SALDO
 *   Row 16+   data rows (FECHA as "DD/MM" or "D/MM" strings, no year per row)
 *   Last row  null | "FIN ESTADO DE CUENTA" | ...
 *
 * Year derivation:
 *   FECHA rows contain only day/month — no year. The period header at row 8
 *   provides "DESDE" (start date, YYYY/MM/DD) and "HASTA" (end date, YYYY/MM/DD).
 *   We start at the year of DESDE and advance the year whenever the month
 *   decreases relative to the previous row (January after December = new year).
 *
 * Sign convention (NATIVE — same as the 4-col savings parser):
 *   Positive VALOR → ingreso → direction='in'
 *   Negative VALOR → gasto  → direction='out'
 *   amountCents is always positive; semantics are in direction.
 *
 * VALOR is stored as a formatted COP string ("−11,175.00", "100,000.00", "-.07").
 * We strip commas and parse as float, then convert to cents.
 */
export function parseBancolombiaSavingsExtracto(buffer: Buffer | Uint8Array): ParsedStatement {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new StatementParseError("missing_sheet", "workbook has no sheets");
  }
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new StatementParseError("missing_sheet", `sheet "${sheetName}" not found`);
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false, // read as formatted strings (VALOR/SALDO are stored as strings)
    defval: null,
  });

  // -------------------------------------------------------------------------
  // Step 1: Find the data header row (scan first 30 rows)
  // -------------------------------------------------------------------------
  const headerRowIndex = findHeaderRow(matrix);
  if (headerRowIndex === -1) {
    throw new StatementParseError(
      "format_mismatch",
      `Extracto header [${EXTRACTO_HEADERS.join(", ")}] not found in first 30 rows`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: Extract the period start year from the title section (row 8 = index 7)
  // -------------------------------------------------------------------------
  const startYear = extractStartYear(matrix);

  // -------------------------------------------------------------------------
  // Step 3: Parse data rows
  //
  // Multi-section robustness: Bancolombia "Estado de Cuenta" exports that
  // span multiple cycles concatenate one section per cycle in the same sheet.
  // Each section is structured as: "Información Cliente:" → cliente row →
  // "Información General:" → period row → "Movimientos:" → header row → data.
  // We can't just stop at the first non-date row — instead we recognize known
  // section-break markers, scan forward for the next FECHA header, and resume.
  // -------------------------------------------------------------------------
  const dataRows = matrix.slice(headerRowIndex + 1);
  const rows: ParsedStatementRow[] = [];
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  let lastBalanceCents: bigint | null = null;

  let currentYear = startYear;
  let prevMonth: number | null = null;

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];
    if (!Array.isArray(raw)) continue;

    const [fecha, descripcion, sucursal, dcto, valor, saldo] = raw as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ];

    // Sentinel: FECHA null + DESCRIPCIÓN = END_SENTINEL
    if (fecha === null || fecha === undefined || fecha === "") {
      const desc = String(descripcion ?? "").trim();
      if (desc === END_SENTINEL) break;
      // Skip blank-fecha rows but don't end parsing — multi-section files
      // have blank rows between sections.
      continue;
    }

    const fechaStr = String(fecha).trim();

    // Section-break detection: when we see a known section title in the FECHA
    // column, scan forward for the next FECHA header and resume from there.
    if (isSectionBreakMarker(fechaStr)) {
      const nextHeader = findNextHeaderRowIndex(dataRows, i);
      if (nextHeader === -1) break; // no more sections
      i = nextHeader; // loop's i++ moves past the header into the next section's first data row
      continue;
    }

    const parsed = parseFecha(fechaStr, currentYear, prevMonth);
    if (!parsed) {
      throw new StatementParseError(
        "bad_row",
        `row ${headerRowIndex + i + 2}: FECHA "${fechaStr}" is not a valid D/MM or DD/MM date`,
      );
    }

    // Advance year if month wrapped backward (e.g. 12 → 1)
    if (prevMonth !== null && parsed.month < prevMonth) {
      currentYear++;
      parsed.year = currentYear;
    }
    prevMonth = parsed.month;

    const occurredAt = buildBogotaUtc(parsed.year, parsed.month, parsed.day);

    const valorStr = String(valor ?? "").trim();
    const valorNum = parseColombianNumber(valorStr);
    if (!Number.isFinite(valorNum)) {
      throw new StatementParseError(
        "bad_row",
        `row ${headerRowIndex + i + 2}: VALOR "${valorStr}" is not a valid number`,
      );
    }

    const direction: "in" | "out" = valorNum < 0 ? "out" : "in";
    const amountCents = BigInt(Math.round(Math.abs(valorNum) * 100));

    const saldoStr = String(saldo ?? "").trim();
    const saldoNum = parseColombianNumber(saldoStr);
    if (Number.isFinite(saldoNum)) {
      lastBalanceCents = BigInt(Math.round(saldoNum * 100));
    }

    const sucursalStr =
      sucursal !== null && sucursal !== undefined ? String(sucursal).trim() : null;
    const dctoStr = dcto !== null && dcto !== undefined ? String(dcto).trim() : null;

    rows.push({
      occurredAt,
      amountCents,
      currency: "COP",
      direction,
      descriptionRaw: String(descripcion ?? "").trim(),
      rawData: {
        sucursal: sucursalStr || null,
        dcto: dctoStr || null,
        saldo: saldoStr || null,
      },
      isMetadata: false,
    });

    const ms = occurredAt.getTime();
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }

  if (rows.length === 0) {
    throw new StatementParseError("empty", "no valid data rows");
  }

  return {
    bank: "bancolombia",
    format: "bancolombia_savings_extracto",
    periodStart: new Date(minMs),
    periodEnd: new Date(maxMs),
    rowCount: rows.length,
    balanceAtEndCents: lastBalanceCents,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scans the first 30 rows looking for the 6-column Extracto header.
 * Returns the 0-based row index or -1 if not found.
 */
export function findExtractoHeaderRow(matrix: unknown[][]): number {
  return findHeaderRow(matrix);
}

function findHeaderRow(matrix: unknown[][]): number {
  const limit = Math.min(matrix.length, 30);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i];
    if (!Array.isArray(row) || row.length < EXTRACTO_HEADERS.length) continue;
    const match = EXTRACTO_HEADERS.every(
      (expected, col) =>
        String(row[col] ?? "")
          .trim()
          .toUpperCase() === expected,
    );
    if (match) return i;
  }
  return -1;
}

/**
 * Extracts the start year from the period info row.
 * Looks for a row where the first cell looks like "YYYY/MM/DD" within the
 * first 20 rows. Expects the DESDE date in column 1 (index 0).
 *
 * If not found, falls back to the current year (safe for same-year files).
 */
function extractStartYear(matrix: unknown[][]): number {
  const limit = Math.min(matrix.length, 20);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i];
    if (!Array.isArray(row)) continue;
    const cell = String(row[0] ?? "").trim();
    // Match YYYY/MM/DD
    const m = /^(\d{4})\/\d{2}\/\d{2}$/.exec(cell);
    if (m) return parseInt(m[1], 10);
  }
  // Fallback: use current year (shouldn't happen with real Bancolombia exports)
  return new Date().getUTCFullYear();
}

/**
 * Parses a "D/MM" or "DD/MM" date string into day/month/year components.
 * Returns null if parsing fails.
 */
function parseFecha(
  s: string,
  currentYear: number,
  _prevMonth: number | null,
): { day: number; month: number; year: number } | null {
  const m = /^(\d{1,2})\/(\d{2})$/.exec(s);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { day, month, year: currentYear };
}

/**
 * Constructs a Date representing midnight Bogotá (UTC-5) for the given
 * calendar date. Bogotá has no DST, so midnight Bogotá = 05:00 UTC.
 */
function buildBogotaUtc(year: number, month: number, day: number): Date {
  // Date.UTC months are 0-indexed
  const utcMidnightMs = Date.UTC(year, month - 1, day);
  return new Date(utcMidnightMs + 5 * 60 * 60 * 1000);
}

/**
 * Parses a Colombian-formatted number string.
 * Examples: "100,000.00" → 100000, "-11,175.00" → -11175, "-.07" → -0.07, ".14" → 0.14.
 * Strips thousands-separator commas before parsing.
 */
function parseColombianNumber(s: string): number {
  if (!s) return NaN;
  // Remove thousands-separator commas (but preserve decimal dots)
  const normalized = s.replace(/,/g, "");
  return parseFloat(normalized);
}

/**
 * Detects whether a string in the FECHA column looks like a section title
 * from a multi-cycle Extracto export. Bancolombia repeats these labels at
 * the start of each cycle's section.
 */
function isSectionBreakMarker(s: string): boolean {
  const upper = s.toUpperCase();
  return (
    upper.startsWith("INFORMACIÓN") ||
    upper.startsWith("INFORMACION") ||
    upper === "MOVIMIENTOS:" ||
    upper === "RESUMEN:" ||
    upper === "CLIENTE" || // label row of "Información Cliente:" sub-table
    upper === "DESDE" // label row of "Información General:" sub-table
  );
}

/**
 * Scans forward from `startIdx` looking for the next data table header row
 * (FECHA | DESCRIPCIÓN | SUCURSAL | DCTO. | VALOR | SALDO). Returns its
 * 0-based index relative to `dataRows`, or -1 if no further header exists.
 */
function findNextHeaderRowIndex(dataRows: unknown[][], startIdx: number): number {
  for (let i = startIdx; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!Array.isArray(row) || row.length < EXTRACTO_HEADERS.length) continue;
    const match = EXTRACTO_HEADERS.every(
      (expected, col) =>
        String(row[col] ?? "")
          .trim()
          .toUpperCase() === expected,
    );
    if (match) return i;
  }
  return -1;
}
