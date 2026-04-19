import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseBancolombiaSavings } from "./bancolombia-savings";
import { StatementParseError, excelSerialToBogotaUtc } from "./types";

type Row = [
  number | string | null, // Fecha (serial, typically fractional)
  string | null, // Descripción
  string | null, // Referencia
  number | null, // Valor (signed, native)
];

const CORRECT_HEADER = ["Fecha", "Descripción", "Referencia", "Valor"];

function buildXlsx(header: unknown[], rows: Row[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseBancolombiaSavings", () => {
  it("parses a savings-like fixture with correct shape", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46130.20833, "ABONO INTERESES AHORROS", "", 0.18],
      [46130.20833, "PAGO QR PELUQUERIA", "0090860726", -62000],
      [46129.20833, "TRANSFERENCIA CTA SUC VIRTUAL", "91241521350", 1000],
    ]);
    const out = parseBancolombiaSavings(buf);
    expect(out.bank).toBe("bancolombia");
    expect(out.format).toBe("bancolombia_savings");
    expect(out.rowCount).toBe(3);
    expect(out.balanceAtEndCents).toBeNull();
    expect(out.rows.every((r) => r.currency === "COP")).toBe(true);
    expect(out.rows.every((r) => r.isMetadata === false)).toBe(true);
  });

  it("normalizes sign natively: positive → 'in', negative → 'out', amountCents always positive", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127.20833, "ingreso", null, 100000],
      [46127.20833, "gasto", null, -62000],
    ]);
    const out = parseBancolombiaSavings(buf);
    expect(out.rows[0].direction).toBe("in");
    expect(out.rows[0].amountCents).toBe(BigInt(10_000_000));
    expect(out.rows[1].direction).toBe("out");
    expect(out.rows[1].amountCents).toBe(BigInt(6_200_000));
  });

  it("normalizes Referencia: empty string, 'null' literal, null → null; real strings pass through", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127.20833, "empty", "", 100],
      [46127.20833, "null literal", "null", 100],
      [46127.20833, "nil", null, 100],
      [46127.20833, "real", "91218413213", 100],
      [46127.20833, "whitespace", "   ", 100],
    ]);
    const out = parseBancolombiaSavings(buf);
    expect(out.rows[0].rawData.referencia).toBeNull();
    expect(out.rows[1].rawData.referencia).toBeNull();
    expect(out.rows[2].rawData.referencia).toBeNull();
    expect(out.rows[3].rawData.referencia).toBe("91218413213");
    expect(out.rows[4].rawData.referencia).toBeNull();
  });

  it("handles fractional .20833 date serials (strips time → Bogotá midnight UTC)", () => {
    const buf = buildXlsx(CORRECT_HEADER, [[46130.20833, "x", "", 100]]);
    const out = parseBancolombiaSavings(buf);
    const expected = excelSerialToBogotaUtc(46130);
    expect(out.rows[0].occurredAt.toISOString()).toBe(expected.toISOString());
    expect(out.rows[0].occurredAt.getUTCHours()).toBe(5);
  });

  it("captures periodStart/periodEnd from min/max of rows", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46130.20833, "newest", "", 100],
      [46113.20833, "oldest", "", 200],
      [46120.20833, "middle", "", 300],
    ]);
    const out = parseBancolombiaSavings(buf);
    expect(out.periodStart.toISOString()).toBe(excelSerialToBogotaUtc(46113).toISOString());
    expect(out.periodEnd.toISOString()).toBe(excelSerialToBogotaUtc(46130).toISOString());
  });

  it("throws format_mismatch when columns are wrong", () => {
    const buf = buildXlsx(["Fecha", "Descripcion", "Referencia", "Valor"], [[46127, "x", "", 100]]);
    try {
      parseBancolombiaSavings(buf);
    } catch (err) {
      expect(err).toBeInstanceOf(StatementParseError);
      expect((err as StatementParseError).kind).toBe("format_mismatch");
    }
  });

  it("throws empty when there are no data rows", () => {
    const buf = buildXlsx(CORRECT_HEADER, []);
    try {
      parseBancolombiaSavings(buf);
    } catch (err) {
      expect(err).toBeInstanceOf(StatementParseError);
      expect((err as StatementParseError).kind).toBe("empty");
    }
  });

  it("throws bad_row when Valor is non-numeric", () => {
    const buf = buildXlsx(CORRECT_HEADER, [[46127, "x", "", "not-a-number" as unknown as number]]);
    try {
      parseBancolombiaSavings(buf);
    } catch (err) {
      expect(err).toBeInstanceOf(StatementParseError);
      expect((err as StatementParseError).kind).toBe("bad_row");
    }
  });

  it("skips fully-blank rows mid-sheet", () => {
    const buf = buildXlsx(CORRECT_HEADER, [
      [46127, "real", "", 100],
      [null, null, null, null],
      [46126, "also real", "", 200],
    ]);
    const out = parseBancolombiaSavings(buf);
    expect(out.rowCount).toBe(2);
  });
});
