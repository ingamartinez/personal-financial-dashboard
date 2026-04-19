import * as XLSX from "xlsx";
import { parseBancolombiaSavings } from "./parsers/bancolombia-savings";
import { parseBancolombiaTc } from "./parsers/bancolombia-tc";
import { StatementParseError } from "./parsers/types";
import type { ParsedStatement, StatementFormat, StatementBank } from "./parsers/types";

export interface DetectedFormat {
  bank: StatementBank;
  format: StatementFormat;
}

/**
 * Detects the Bancolombia export format by inspecting just the header row.
 * Column count + header text disambiguate:
 *   4 cols (Fecha | Descripción | Referencia | Valor) → savings
 *   6 cols (Fecha | Descripción | Fecha de corte | Valor | Tipo de moneda | Cuotas) → TC
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
    raw: true,
    defval: null,
  });
  const header = matrix[0];
  if (!Array.isArray(header)) {
    throw new StatementParseError("format_mismatch", "no header row");
  }
  const headerNorm = header.map((c) => String(c ?? "").trim());

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
  return { detected, parsed: parseBancolombiaTc(buffer) };
}
