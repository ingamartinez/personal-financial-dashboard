import * as XLSX from "xlsx";

import type {
  ParsedStatement,
  StatementAccount,
  StatementCurrency,
  StatementInstallments,
  StatementKind,
  StatementPeriod,
  StatementRates,
  StatementRow,
  StatementSummary,
} from "./types";

// -----------------------------------------------------------------------------
// Scalar parsers (exported for unit tests)
// -----------------------------------------------------------------------------

// Colombian amounts appear in two formats mixed inside the same file:
//   - "7.744.665,00"   → dot thousands, comma decimal (standard COP)
//   - "4,351,431.00"   → comma thousands, dot decimal (US, used in some rows)
// Rule: the LAST `.` or `,` followed by 1-2 digits is the decimal separator;
// all earlier separators are thousands. Numbers with NO decimals keep every
// separator as thousands (never observed in the fixture but defensive).
export function parseCopAmount(raw: string | number): bigint {
  if (raw == null) throw new Error("parseCopAmount: value is null/undefined");
  const str = typeof raw === "number" ? String(raw) : raw;
  const trimmed = str.trim();
  if (trimmed === "") throw new Error("parseCopAmount: value is empty");

  let body = trimmed.replace(/\s/g, "");

  let negative = false;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    body = body.slice(1, -1);
  }
  body = body.replace(/^(COP|USD|\$)/i, "");

  if (!/^[\d.,]+$/.test(body)) {
    throw new Error(`parseCopAmount: invalid characters in "${raw}"`);
  }

  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);

  let integerPart = body;
  let decimalPart = "";
  if (lastSep !== -1) {
    const after = body.slice(lastSep + 1);
    if (/^\d{1,2}$/.test(after)) {
      integerPart = body.slice(0, lastSep);
      decimalPart = after;
    }
  }

  const intDigits = integerPart.replace(/[.,]/g, "");
  if (!/^\d*$/.test(intDigits)) {
    throw new Error(`parseCopAmount: invalid integer part in "${raw}"`);
  }

  const intVal = intDigits === "" ? BigInt(0) : BigInt(intDigits);
  const centsFromDec = decimalPart === "" ? BigInt(0) : BigInt(decimalPart.padEnd(2, "0"));
  const cents = intVal * BigInt(100) + centsFromDec;
  return negative ? -cents : cents;
}

// Rates in the Bancolombia extracto can be either "1.9110 %" (dot decimal,
// summary section) or "1,8895" (comma decimal, row table). Same rule as above
// applies. Output is EM (mes vencido) × 10_000.
export function parseRateEmX10k(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const str = typeof raw === "number" ? String(raw) : raw;
  const body = str.trim().replace(/\s*%\s*$/, "");
  if (body === "") return null;

  if (!/^[\d.,]+$/.test(body)) {
    throw new Error(`parseRateEmX10k: invalid characters in "${raw}"`);
  }

  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);

  let integerPart = body;
  let decimalPart = "";
  if (lastSep !== -1) {
    integerPart = body.slice(0, lastSep);
    decimalPart = body.slice(lastSep + 1);
  }

  const intDigits = integerPart.replace(/[.,]/g, "");
  const intVal = intDigits === "" ? 0 : Number(intDigits);
  const dec4 = decimalPart.slice(0, 4).padEnd(4, "0");
  const decVal = Number(dec4);
  if (!Number.isFinite(intVal) || !Number.isFinite(decVal)) {
    throw new Error(`parseRateEmX10k: invalid number "${raw}"`);
  }
  return intVal * 10_000 + decVal;
}

export function parseCuotas(raw: string | number | null | undefined): StatementInstallments | null {
  if (raw == null) return null;
  const str = typeof raw === "number" ? String(raw) : raw;
  const trimmed = str.trim();
  if (trimmed === "") return null;
  const m = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) throw new Error(`parseCuotas: expected "N/M", got "${raw}"`);
  const paid = Number(m[1]);
  const total = Number(m[2]);
  if (paid <= 0 || total <= 0 || paid > total) {
    throw new Error(`parseCuotas: invalid values in "${raw}"`);
  }
  return { paid, total };
}

export function parseStatementDate(raw: string): Date {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`parseStatementDate: expected DD/MM/YYYY, got "${raw}"`);
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`parseStatementDate: out-of-range components in "${raw}"`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

const ES_MONTH_INDEX: Record<string, number> = {
  ene: 0,
  feb: 1,
  mar: 2,
  abr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  ago: 7,
  sep: 8,
  set: 8, // rare variant
  oct: 9,
  nov: 10,
  dic: 11,
};

export function parseSpanishDate(raw: string): Date {
  const s = raw.trim().toLowerCase();
  // "abr. 16, 2026" / "abr 16 2026"
  let m = s.match(/^([a-zñ]{3})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = ES_MONTH_INDEX[m[1]];
    if (month === undefined) throw new Error(`parseSpanishDate: unknown month in "${raw}"`);
    return new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  }
  // "30 mar. 2026" / "30 mar 2026"
  m = s.match(/^(\d{1,2})\s+([a-zñ]{3})\.?\s+(\d{4})$/);
  if (m) {
    const month = ES_MONTH_INDEX[m[2]];
    if (month === undefined) throw new Error(`parseSpanishDate: unknown month in "${raw}"`);
    return new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
  }
  throw new Error(`parseSpanishDate: unrecognized format "${raw}"`);
}

// Start of the period may be yearless ("28 feb"); end always has a year. If
// start month > end month, we assume the period crossed the calendar boundary.
export function parsePeriod(
  startRaw: string,
  endRaw: string,
): {
  startDate: Date;
  endDate: Date;
} {
  const endDate = parseSpanishDate(endRaw);
  const endYear = endDate.getUTCFullYear();
  const endMonth = endDate.getUTCMonth();

  const s = startRaw.trim().toLowerCase();
  // Try yearful start first.
  const withYear = s.match(/^(\d{1,2})\s+([a-zñ]{3})\.?\s+(\d{4})$/);
  if (withYear) {
    return { startDate: parseSpanishDate(startRaw), endDate };
  }
  const m = s.match(/^(\d{1,2})\s+([a-zñ]{3})\.?$/);
  if (!m) throw new Error(`parsePeriod: invalid start "${startRaw}"`);
  const month = ES_MONTH_INDEX[m[2]];
  if (month === undefined) throw new Error(`parsePeriod: unknown month in "${startRaw}"`);
  const year = month > endMonth ? endYear - 1 : endYear;
  const startDate = new Date(Date.UTC(year, month, Number(m[1])));
  return { startDate, endDate };
}

// -----------------------------------------------------------------------------
// Main parser
// -----------------------------------------------------------------------------

type SheetRows = (string | null)[][];

function loadSheet(buffer: Buffer): { name: string; rows: SheetRows } {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", raw: false, cellDates: false });
  } catch (err) {
    throw new Error(`parseBancolombiaStatement: not a valid xlsx file (${(err as Error).message})`);
  }
  const sheetName = wb.SheetNames.find((n) => n.toUpperCase() === "PESOS") ?? wb.SheetNames[0];
  if (!sheetName) {
    throw new Error("parseBancolombiaStatement: workbook has no sheets");
  }
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`parseBancolombiaStatement: sheet "${sheetName}" missing`);
  }
  const rows = XLSX.utils.sheet_to_json<(string | null)[]>(sheet, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: true,
  });
  return { name: sheetName, rows };
}

function cellText(rows: SheetRows, rowIdx: number, colIdx: number): string {
  const row = rows[rowIdx];
  if (!row) return "";
  const v = row[colIdx];
  if (v == null) return "";
  return String(v).trim();
}

function findRowContaining(rows: SheetRows, substring: string, colIdx: number): number {
  const needle = substring.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if (cellText(rows, i, colIdx).toLowerCase().includes(needle)) return i;
  }
  return -1;
}

function extractAccount(rows: SheetRows): StatementAccount {
  const cardRow = findRowContaining(rows, "información de la tarjeta", 0);
  if (cardRow === -1) {
    throw new Error('parseBancolombiaStatement: missing "Información de la Tarjeta" row');
  }
  const cardRaw = cellText(rows, cardRow, 1);
  const last4Match = cardRaw.match(/(\d{4})\s*$/);
  if (!last4Match) {
    throw new Error(`parseBancolombiaStatement: cannot extract card last4 from "${cardRaw}"`);
  }

  const monedaRow = findRowContaining(rows, "moneda", 0);
  if (monedaRow === -1) {
    throw new Error('parseBancolombiaStatement: missing "Moneda" row');
  }
  const monedaRaw = cellText(rows, monedaRow, 1).toUpperCase();
  let currency: StatementCurrency;
  if (monedaRaw.includes("PESOS") || monedaRaw === "COP") currency = "COP";
  else if (monedaRaw.includes("USD") || monedaRaw.includes("DOLAR")) currency = "USD";
  else throw new Error(`parseBancolombiaStatement: unknown currency "${monedaRaw}"`);

  return { last4: last4Match[1], currency };
}

function extractPeriod(rows: SheetRows): StatementPeriod {
  const periodoRow = findRowContaining(rows, "periodo facturado", 0);
  if (periodoRow === -1) {
    throw new Error('parseBancolombiaStatement: missing "Periodo facturado" row');
  }
  const startRaw = cellText(rows, periodoRow, 1);
  const endRaw = cellText(rows, periodoRow, 2);
  if (!startRaw || !endRaw) {
    throw new Error('parseBancolombiaStatement: "Periodo facturado" missing start or end');
  }
  const { startDate, endDate } = parsePeriod(startRaw, endRaw);

  const dueRow = findRowContaining(rows, "pagar antes de", 0);
  if (dueRow === -1) {
    throw new Error('parseBancolombiaStatement: missing "Pagar antes de" row');
  }
  const dueRaw = cellText(rows, dueRow, 1);
  if (!dueRaw) {
    throw new Error('parseBancolombiaStatement: "Pagar antes de" has no value');
  }
  const dueDate = parseSpanishDate(dueRaw);

  return { startDate, endDate, dueDate };
}

function findSummaryValueByLabel(
  rows: SheetRows,
  label: string,
  labelCol: number,
  valueCol: number,
): string {
  const needle = label.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    if (cellText(rows, i, labelCol).toLowerCase().includes(needle)) {
      return cellText(rows, i, valueCol);
    }
  }
  throw new Error(`parseBancolombiaStatement: missing summary row "${label}"`);
}

function extractSummary(rows: SheetRows): StatementSummary {
  // Summary lives in two groups:
  //   - Header key/value (rows 10-11): Pago mínimo, Pago total — col A / col B.
  //   - Summary table (rows 18-27): + Saldo anterior / + Compras del mes / etc
  //     labels in col D, values in col E.
  const minPayRaw = findSummaryValueByLabel(rows, "pago mínimo", 0, 1);
  const totalPayRaw = findSummaryValueByLabel(rows, "pago total", 0, 1);

  const previousRaw = findSummaryValueByLabel(rows, "saldo anterior", 3, 4);
  const purchasesRaw = findSummaryValueByLabel(rows, "compras del mes", 3, 4);
  const interestRaw = findSummaryValueByLabel(rows, "intereses corrientes", 3, 4);
  const paymentsRaw = findSummaryValueByLabel(rows, "pagos / abonos", 3, 4);

  return {
    previousBalanceCents: parseCopAmount(previousRaw),
    purchasesCents: parseCopAmount(purchasesRaw),
    interestCorrientesCents: parseCopAmount(interestRaw),
    paymentsCents: parseCopAmount(paymentsRaw),
    minPaymentCents: parseCopAmount(minPayRaw),
    totalPaymentCents: parseCopAmount(totalPayRaw),
  };
}

function extractRates(rows: SheetRows): StatementRates {
  const rateFor = (label: string): number => {
    const needle = label.toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      if (cellText(rows, i, 0).toLowerCase().includes(needle)) {
        const parsed = parseRateEmX10k(cellText(rows, i, 1));
        if (parsed == null) {
          throw new Error(`parseBancolombiaStatement: rate for "${label}" is empty`);
        }
        return parsed;
      }
    }
    throw new Error(`parseBancolombiaStatement: missing rate row "${label}"`);
  };
  return {
    oneMonth: rateFor("compra un mes"),
    months2to36: rateFor("compra 2 - 36 meses"),
    advances: rateFor("avances"),
  };
}

// Data rows use these column indexes under the "Número de autorización | Fecha
// | Movimientos | Valor Movimiento | Número de cuotas | Valor cuota/abono |
// Interés mensual (%) | Interés anual (%) | Saldo pendiente" header.
const COL_AUTH = 0;
const COL_DATE = 1;
const COL_MERCHANT = 2;
const COL_AMOUNT = 3;
const COL_CUOTAS = 4;
const COL_CUOTA_VALUE = 5;
const COL_RATE_EM = 6;
const COL_SALDO_PENDING = 8;

function isRowDataRow(rows: SheetRows, rowIdx: number): boolean {
  const dateCell = cellText(rows, rowIdx, COL_DATE);
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateCell)) return false;
  const merchant = cellText(rows, rowIdx, COL_MERCHANT);
  if (merchant === "") return false;
  const amount = cellText(rows, rowIdx, COL_AMOUNT);
  if (amount === "") return false;
  return true;
}

function parseRow(rows: SheetRows, rowIdx: number, kind: StatementKind): StatementRow {
  const authRaw = cellText(rows, rowIdx, COL_AUTH);
  const dateRaw = cellText(rows, rowIdx, COL_DATE);
  const merchantRaw = cellText(rows, rowIdx, COL_MERCHANT);
  const amountRaw = cellText(rows, rowIdx, COL_AMOUNT);
  const cuotasRaw = cellText(rows, rowIdx, COL_CUOTAS);
  const cuotaValueRaw = cellText(rows, rowIdx, COL_CUOTA_VALUE);
  const rateRaw = cellText(rows, rowIdx, COL_RATE_EM);
  const saldoRaw = cellText(rows, rowIdx, COL_SALDO_PENDING);

  const occurredAt = parseStatementDate(dateRaw);
  const amountCents = parseCopAmount(amountRaw);
  const installments = parseCuotas(cuotasRaw);
  const installmentValueCents = cuotaValueRaw === "" ? null : parseCopAmount(cuotaValueRaw);
  const rateEmX10k = parseRateEmX10k(rateRaw);
  const saldoPendingCents = saldoRaw === "" ? BigInt(0) : parseCopAmount(saldoRaw);

  return {
    kind,
    authorizationNumber: authRaw === "" ? null : authRaw,
    occurredAt,
    merchant: merchantRaw,
    amountCents,
    installments,
    installmentValueCents,
    rateEmX10k,
    saldoPendingCents,
  };
}

function extractStatementRows(rows: SheetRows): StatementRow[] {
  const out: StatementRow[] = [];
  let kind: StatementKind = "during-period";
  for (let i = 0; i < rows.length; i++) {
    const firstCol = cellText(rows, i, 0).toLowerCase();
    if (firstCol.startsWith("movimientos antes del periodo")) {
      kind = "before-period";
      continue;
    }
    if (firstCol.startsWith("movimientos durante el periodo")) {
      kind = "during-period";
      continue;
    }
    // Skip repeated table header rows.
    if (firstCol === "número de autorización") continue;
    if (!isRowDataRow(rows, i)) continue;
    out.push(parseRow(rows, i, kind));
  }
  if (out.length === 0) {
    throw new Error("parseBancolombiaStatement: no movimientos rows found");
  }
  return out;
}

export function parseBancolombiaStatement(buffer: Buffer): ParsedStatement {
  const { rows } = loadSheet(buffer);
  const account = extractAccount(rows);
  const period = extractPeriod(rows);
  const summary = extractSummary(rows);
  const currentRates = extractRates(rows);
  const statementRows = extractStatementRows(rows);
  return { account, period, summary, currentRates, rows: statementRows };
}
