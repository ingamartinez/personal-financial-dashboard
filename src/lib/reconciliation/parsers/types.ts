export type ParseDirection = "in" | "out";

export type StatementFormat =
  | "bancolombia_tc"
  | "bancolombia_savings"
  | "bancolombia_savings_extracto";

export type StatementBank = "bancolombia";

export interface ParsedStatementRow {
  occurredAt: Date;
  amountCents: bigint;
  currency: "COP" | "USD";
  direction: ParseDirection;
  descriptionRaw: string;
  rawData: Record<string, unknown>;
  isMetadata: boolean;
}

export interface ParsedStatement {
  bank: StatementBank;
  format: StatementFormat;
  periodStart: Date;
  periodEnd: Date;
  rowCount: number;
  balanceAtEndCents: bigint | null;
  rows: ParsedStatementRow[];
}

export type StatementParseErrorKind = "format_mismatch" | "missing_sheet" | "bad_row" | "empty";

export class StatementParseError extends Error {
  constructor(
    public readonly kind: StatementParseErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "StatementParseError";
  }
}

/**
 * Excel stores dates as serial days since 1899-12-30 (accounting for the
 * legacy 1900 leap-year bug — day 1 = 1900-01-01). Bancolombia TC exports
 * give us integer serials (date only, no time). Bogotá is UTC-5 with no
 * DST, so "midnight Bogotá" on a given calendar date == 05:00 UTC.
 */
export function excelSerialToBogotaUtc(serial: number): Date {
  const days = Math.floor(serial);
  const utcMidnightMs = Date.UTC(1899, 11, 30) + days * 86_400_000;
  return new Date(utcMidnightMs + 5 * 60 * 60 * 1000);
}
