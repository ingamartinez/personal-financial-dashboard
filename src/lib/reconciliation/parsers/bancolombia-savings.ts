import * as XLSX from "xlsx";
import {
  StatementParseError,
  excelSerialToBogotaUtc,
  type ParsedStatement,
  type ParsedStatementRow,
} from "./types";

const EXPECTED_HEADERS = ["Fecha", "Descripción", "Referencia", "Valor"] as const;

/**
 * Parses a Bancolombia savings-account statement (format A — 4 columns).
 *
 * Sign is NATIVE here — opposite of TC:
 *   `+` Valor = ingreso (direction='in')
 *   `−` Valor = gasto (direction='out')
 * `amountCents` is ALWAYS positive; the semantic is in `direction`.
 *
 * Savings exports use a fractional serial (`46130.20833`) where `.20833`
 * encodes 05:00 UTC (= midnight Bogotá). The fraction is constant across
 * rows and redundant — we strip it and interpret as a calendar date in
 * Bogotá, same as the TC parser.
 */
export function parseBancolombiaSavings(buffer: Buffer | Uint8Array): ParsedStatement {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) {
    throw new StatementParseError("missing_sheet", "workbook has no sheets");
  }
  const ws = wb.Sheets[firstSheetName];
  if (!ws) {
    throw new StatementParseError("missing_sheet", `sheet "${firstSheetName}" not found`);
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
  });

  const header = matrix[0];
  if (!Array.isArray(header) || header.length < EXPECTED_HEADERS.length) {
    throw new StatementParseError(
      "format_mismatch",
      `expected ${EXPECTED_HEADERS.length} columns, got ${header?.length ?? 0}`,
    );
  }
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    const actual = String(header[i] ?? "").trim();
    if (actual !== EXPECTED_HEADERS[i]) {
      throw new StatementParseError(
        "format_mismatch",
        `column ${i}: expected "${EXPECTED_HEADERS[i]}", got "${actual}"`,
      );
    }
  }

  const dataRows = matrix.slice(1);
  const rows: ParsedStatementRow[] = [];
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const [fecha, descripcion, referencia, valor] = raw;
    if (fecha === null || fecha === undefined || fecha === "") continue;

    const fechaNum = Number(fecha);
    if (!Number.isFinite(fechaNum)) {
      throw new StatementParseError(
        "bad_row",
        `row ${i + 2}: Fecha is not numeric (got "${String(fecha)}")`,
      );
    }
    const occurredAt = excelSerialToBogotaUtc(fechaNum);

    const valorNum = Number(valor);
    if (!Number.isFinite(valorNum)) {
      throw new StatementParseError(
        "bad_row",
        `row ${i + 2}: Valor is not numeric (got "${String(valor)}")`,
      );
    }
    const direction: "in" | "out" = valorNum < 0 ? "out" : "in";
    const amountCents = BigInt(Math.round(Math.abs(valorNum) * 100));

    const referenciaStr = normalizeReferencia(referencia);

    rows.push({
      occurredAt,
      amountCents,
      currency: "COP",
      direction,
      descriptionRaw: String(descripcion ?? "").trim(),
      rawData: { referencia: referenciaStr },
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
    format: "bancolombia_savings",
    periodStart: new Date(minMs),
    periodEnd: new Date(maxMs),
    rowCount: rows.length,
    balanceAtEndCents: null,
    rows,
  };
}

function normalizeReferencia(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "" || s.toLowerCase() === "null") return null;
  return s;
}
