import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseBancolombiaXlsx } from "./xlsx-bancolombia";

function makeXlsx(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseBancolombiaXlsx", () => {
  it("parses headers + happy path rows", () => {
    const buf = makeXlsx([
      ["Fecha", "Descripción", "Referencia", "Valor"],
      [new Date("2026-04-15T12:00:00Z"), "PAGO QR FOO", "0091498581", -92000],
      [new Date("2026-04-14T12:00:00Z"), "TRANSF DE BAR", "null", 100000],
    ]);
    const { rows, skipped } = parseBancolombiaXlsx(buf, 1);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].occurredOn).toBe("2026-04-15");
    expect(rows[0].amountCents).toBe(BigInt(-9200000));
    expect(rows[0].externalId).toMatch(/^bcol:1:[a-f0-9]{24}$/);
    expect(rows[1].reference).toBeNull();
    expect(rows[1].externalId).toMatch(/^bcol:1:[a-f0-9]{24}$/);
    expect(rows[0].externalId).not.toBe(rows[1].externalId);
  });

  it("preserves decimal amounts without floating-point drift", () => {
    const buf = makeXlsx([
      ["Fecha", "Descripción", "Referencia", "Valor"],
      [new Date("2026-04-15T12:00:00Z"), "PAGO TC", "", -1320564.6],
    ]);
    const { rows } = parseBancolombiaXlsx(buf, 1);
    expect(rows[0].amountCents).toBe(BigInt(-132056460));
  });

  it("skips invalid rows but keeps valid ones", () => {
    const buf = makeXlsx([
      ["Fecha", "Descripción", "Referencia", "Valor"],
      ["", "", "", ""],
      [new Date("2026-04-15T12:00:00Z"), "OK", "REF1", -1000],
      [new Date("2026-04-14T12:00:00Z"), "", "REF2", -2000],
      [new Date("2026-04-13T12:00:00Z"), "ZERO", "REF3", 0],
    ]);
    const { rows, skipped } = parseBancolombiaXlsx(buf, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("OK");
    expect(skipped.map((s) => s.reason)).toEqual([
      "Missing description",
      "Invalid amount: 0",
    ]);
  });

  it("rejects unexpected headers", () => {
    const buf = makeXlsx([["Date", "Memo", "Ref", "Amount"]]);
    const { rows, skipped } = parseBancolombiaXlsx(buf, 1);
    expect(rows).toEqual([]);
    expect(skipped[0].reason).toMatch(/Unexpected headers/);
  });

  it("produces stable externalId for same row on repeated parses", () => {
    const rows = [
      ["Fecha", "Descripción", "Referencia", "Valor"],
      [new Date("2026-04-15T12:00:00Z"), "TRANSF", "", -5000],
    ];
    const a = parseBancolombiaXlsx(makeXlsx(rows), 1);
    const b = parseBancolombiaXlsx(makeXlsx(rows), 1);
    expect(a.rows[0].externalId).toBe(b.rows[0].externalId);
  });

  it("disambiguates rows with identical reference and amount on the same day", () => {
    const buf = makeXlsx([
      ["Fecha", "Descripción", "Referencia", "Valor"],
      [new Date("2026-04-15T12:00:00Z"), "PAGO QR FOO", "988044474", -5000],
      [new Date("2026-04-15T12:00:00Z"), "PAGO QR FOO", "988044474", -5000],
      [new Date("2026-04-15T12:00:00Z"), "PAGO QR FOO", "988044474", -5000],
    ]);
    const { rows } = parseBancolombiaXlsx(buf, 1);
    expect(rows).toHaveLength(3);
    const ids = new Set(rows.map((r) => r.externalId));
    expect(ids.size).toBe(3);
  });
});
