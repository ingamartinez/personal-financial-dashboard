import * as XLSX from "xlsx";
import { parseBancolombiaSavings } from "./parsers/bancolombia-savings";
import { parseBancolombiaSavingsExtracto } from "./parsers/bancolombia-savings-extracto";
import { findExtractoHeaderRow } from "./parsers/bancolombia-savings-extracto";
import { parseBancolombiaTc } from "./parsers/bancolombia-tc";
import { StatementParseError } from "./parsers/types";
import type { ParsedStatement, StatementFormat, StatementBank } from "./parsers/types";

export interface DetectedFormat {
  bank: StatementBank;
  format: StatementFormat;
}

/**
 * Detects the Bancolombia export format by inspecting the header row(s).
 * Three formats are recognized:
 *
 *   Format A — 4-col Movimientos (header at row 1):
 *     Fecha | Descripción | Referencia | Valor
 *   Format B — 6-col Extracto Mensual (header at row ~15, scan first 30 rows):
 *     FECHA | DESCRIPCIÓN | SUCURSAL | DCTO. | VALOR | SALDO
 *   Format C — 6-col TC (header at row 1):
 *     Fecha | Descripción | Fecha de corte | Valor | Tipo de moneda | Cuotas
 *
 * Anything else → StatementParseError('format_mismatch').
 */
export function detectFormat(buffer: Buffer | Uint8Array): DetectedFormat {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new StatementParseError("missing_sheet", "workbook has no sheets");
  }
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    throw new StatementParseError("missing_sheet", `sheet "${sheetName}" not found`);
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: null,
  });

  // --- Format A: 4-col Movimientos (header at row 0) ---
  const header0 = matrix[0];
  if (Array.isArray(header0)) {
    const headerNorm = header0.map((c) => String(c ?? "").trim());

    if (headerMatches(headerNorm, ["Fecha", "Descripción", "Referencia", "Valor"])) {
      return { bank: "bancolombia", format: "bancolombia_savings" };
    }
    if (
      headerMatches(headerNorm, [
        "Fecha",
        "Descripción",
        "Fecha de corte",
        "Valor",
        "Tipo de moneda",
        "Cuotas",
      ])
    ) {
      return { bank: "bancolombia", format: "bancolombia_tc" };
    }
  }

  // --- Format B: 6-col Extracto Mensual (header anywhere in first 30 rows) ---
  if (findExtractoHeaderRow(matrix as unknown[][]) !== -1) {
    return { bank: "bancolombia", format: "bancolombia_savings_extracto" };
  }

  const headerNorm = Array.isArray(header0) ? header0.map((c) => String(c ?? "").trim()) : [];
  throw new StatementParseError(
    "format_mismatch",
    `unrecognized header: [${headerNorm.join(", ")}]`,
  );
}

function headerMatches(actual: string[], expected: string[]): boolean {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

export function parseAny(buffer: Buffer | Uint8Array): {
  detected: DetectedFormat;
  parsed: ParsedStatement;
} {
  const detected = detectFormat(buffer);
  if (detected.format === "bancolombia_savings") {
    return { detected, parsed: parseBancolombiaSavings(buffer) };
  }
  if (detected.format === "bancolombia_savings_extracto") {
    return { detected, parsed: parseBancolombiaSavingsExtracto(buffer) };
  }
  return { detected, parsed: parseBancolombiaTc(buffer) };
}
