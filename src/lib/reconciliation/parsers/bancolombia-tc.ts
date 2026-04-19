import * as XLSX from "xlsx";
import {
  StatementParseError,
  excelSerialToBogotaUtc,
  type ParsedStatement,
  type ParsedStatementRow,
} from "./types";

const EXPECTED_HEADERS = [
  "Fecha",
  "Descripción",
  "Fecha de corte",
  "Valor",
  "Tipo de moneda",
  "Cuotas",
] as const;

/**
 * Parses a Bancolombia credit card statement (shared across Visa and
 * Mastercard exports — structurally identical; currency is per-row).
 *
 * Sign convention in Bancolombia TC exports is inverted vs. savings:
 *   `+` Valor = charge to card (direction='out')
 *   `−` Valor = abono/payment received (direction='in')
 * The caller gets `amountCents` ALWAYS positive with the semantic in
 * `direction`, so downstream code never has to reason about the file's
 * signed representation.
 */
export function parseBancolombiaTc(buffer: Buffer | Uint8Array): ParsedStatement {
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
    const [fecha, descripcion, fechaCorte, valor, tipoMoneda, cuotas] = raw;
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
    const direction: "in" | "out" = valorNum < 0 ? "in" : "out";
    const amountCents = BigInt(Math.round(Math.abs(valorNum) * 100));

    const currency: "COP" | "USD" =
      String(tipoMoneda).trim().toUpperCase() === "USD" ? "USD" : "COP";

    const cuotasNum = Number(cuotas ?? 0);
    const isMetadata = Number.isFinite(cuotasNum) && cuotasNum === 0;

    const fechaCorteNum =
      fechaCorte === null || fechaCorte === undefined || fechaCorte === ""
        ? null
        : Number(fechaCorte);
    const fechaCorteIso =
      fechaCorteNum !== null && Number.isFinite(fechaCorteNum)
        ? excelSerialToBogotaUtc(fechaCorteNum).toISOString()
        : null;

    rows.push({
      occurredAt,
      amountCents,
      currency,
      direction,
      descriptionRaw: String(descripcion ?? "").trim(),
      rawData: {
        cuotas: Number.isFinite(cuotasNum) ? cuotasNum : null,
        fechaDeCorte: fechaCorteIso,
        tipoMoneda: currency,
      },
      isMetadata,
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
    format: "bancolombia_tc",
    periodStart: new Date(minMs),
    periodEnd: new Date(maxMs),
    rowCount: rows.length,
    balanceAtEndCents: null,
    rows,
  };
}
