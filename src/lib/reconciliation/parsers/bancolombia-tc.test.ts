import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseBancolombiaTc } from "./bancolombia-tc";
import { StatementParseError, excelSerialToBogotaUtc } from "./types";

type Row = [
  number | string | null, // Fecha (serial)
  string | null, // Descripción
  number | string | null, // Fecha de corte (serial or null)
  number | null, // Valor (signed)
  "COP" | "USD" | null, // Tipo de moneda
  number | null, // Cuotas
];

const CORRECT_HEADER = [
  "Fecha",
  "Descripción",
  "Fecha de corte",
  "Valor",
  "Tipo de moneda",
  "Cuotas",
];

function buildXlsx(header: unknown[], rows: Row[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseBancolombiaTc", () => {
  it("parses a Visa-like fixture (all COP) with correct shape", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "DLO*DIDI FOOD", null, 35450, "COP", 1],
      [46127, "RAPPI COLOMBIA", null, 71950, "COP", 1],
      [46126, "ABONO SUCURSAL VIRTUAL", null, -4351431, "COP", 0],
      [46126, "SPRED", null, 36641.38, "COP", 36],
    ]);
    const out = parseBancolombiaTc(buf);
    expect(out.bank).toBe("bancolombia");
    expect(out.format).toBe("bancolombia_tc");
    expect(out.rowCount).toBe(4);
    expect(out.balanceAtEndCents).toBeNull();
    expect(out.rows.every((r) => r.currency === "COP")).toBe(true);
  });

  it("parses a Mastercard-like fixture with mixed COP and USD", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "ANTHROPIC", null, 10, "USD", 36],
      [46127, "CLAUDE.AI", null, 195.26, "USD", 36],
      [46126, "ABONO SUC VIRTUAL", null, -130469, "COP", 0],
      [46126, "ABONO SUC VIRTUAL", null, -366, "USD", 0],
      [46111, "INTERESES", 46111, 26470.92, "COP", 0],
    ]);
    const out = parseBancolombiaTc(buf);
    const currencies = out.rows.map((r) => r.currency);
    expect(currencies).toEqual(["USD", "USD", "COP", "USD", "COP"]);
  });

  it("normalizes sign: positive Valor → direction='out', negative → 'in', amountCents always positive", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "charge", null, 5000, "COP", 1],
      [46127, "abono", null, -5000, "COP", 0],
    ]);
    const out = parseBancolombiaTc(buf);
    expect(out.rows[0].direction).toBe("out");
    expect(out.rows[0].amountCents).toBe(BigInt(500_000));
    expect(out.rows[1].direction).toBe("in");
    expect(out.rows[1].amountCents).toBe(BigInt(500_000));
  });

  it("converts USD decimals to cents without precision loss", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "usd small", null, 195.26, "USD", 36],
      [46127, "usd tiny", null, 0.18, "USD", 0],
      [46127, "usd large", null, 4099523.37, "COP", 60],
    ]);
    const out = parseBancolombiaTc(buf);
    expect(out.rows[0].amountCents).toBe(BigInt(19526));
    expect(out.rows[1].amountCents).toBe(BigInt(18));
    expect(out.rows[2].amountCents).toBe(BigInt(409_952_337));
  });

  it("flags cuotas=0 rows as metadata; non-zero as regular", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "fee", null, 35672, "COP", 0],
      [46127, "single", null, 5000, "COP", 1],
      [46127, "installments", null, 60000, "COP", 12],
    ]);
    const out = parseBancolombiaTc(buf);
    expect(out.rows[0].isMetadata).toBe(true);
    expect(out.rows[1].isMetadata).toBe(false);
    expect(out.rows[2].isMetadata).toBe(false);
    expect(out.rows[2].rawData.cuotas).toBe(12);
  });

  it("converts Excel serial to Bogotá midnight UTC (05:00Z)", () => {
    // Serial 46127 → 2026-04-16 UTC date by Excel convention
    // Bogotá midnight on 2026-04-16 == 2026-04-16T05:00:00Z
    const ref = excelSerialToBogotaUtc(46127);
    const buf = buildXlsx(CORRECT_HEADER, [[46127, "x", null, 100, "COP", 1]]);
    const out = parseBancolombiaTc(buf);
    expect(out.rows[0].occurredAt.toISOString()).toBe(ref.toISOString());
    expect(out.rows[0].occurredAt.getUTCHours()).toBe(5);
    expect(out.rows[0].occurredAt.getUTCMinutes()).toBe(0);
  });

  it("captures periodStart/periodEnd from min/max of rows", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "latest", null, 100, "COP", 1],
      [46120, "earliest", null, 200, "COP", 1],
      [46124, "middle", null, 300, "COP", 1],
    ]);
    const out = parseBancolombiaTc(buf);
    expect(out.periodStart.toISOString()).toBe(excelSerialToBogotaUtc(46120).toISOString());
    expect(out.periodEnd.toISOString()).toBe(excelSerialToBogotaUtc(46127).toISOString());
  });

  it("captures fechaDeCorte when present, null when NaN/blank", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "pending", null, 100, "COP", 1],
      [46111, "billed", 46111, 200, "COP", 0],
    ]);
    const out = parseBancolombiaTc(buf);
    expect(out.rows[0].rawData.fechaDeCorte).toBeNull();
    expect(out.rows[1].rawData.fechaDeCorte).toBe(excelSerialToBogotaUtc(46111).toISOString());
  });

  it("throws format_mismatch when columns are wrong", () => {
    const buf = buildXlsx(
      ["Fecha", "Descripcion", "Fecha de corte", "Valor", "Tipo", "Cuotas"],
      [[46127, "x", null, 100, "COP", 1]],
    );
    expect(() => parseBancolombiaTc(buf)).toThrow(StatementParseError);
    try {
      parseBancolombiaTc(buf);
    } catch (err) {
      expect((err as StatementParseError).kind).toBe("format_mismatch");
    }
  });

  it("throws empty when there are no data rows", () => {
    const buf = buildXlsx(CORRECT_HEADER, []);
    expect(() => parseBancolombiaTc(buf)).toThrow(StatementParseError);
    try {
      parseBancolombiaTc(buf);
    } catch (err) {
      expect((err as StatementParseError).kind).toBe("empty");
    }
  });

  it("throws bad_row when Valor is non-numeric", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "x", null, "not-a-number" as unknown as number, "COP", 1],
    ]);
    try {
      parseBancolombiaTc(buf);
    } catch (err) {
      expect(err).toBeInstanceOf(StatementParseError);
      expect((err as StatementParseError).kind).toBe("bad_row");
    }
  });

  it("skips fully-blank rows mid-sheet", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "real", null, 100, "COP", 1],
      [null, null, null, null, null, null],
      [46126, "also real", null, 200, "COP", 1],
    ]);
    const out = parseBancolombiaTc(buf);
    expect(out.rowCount).toBe(2);
  });
});
