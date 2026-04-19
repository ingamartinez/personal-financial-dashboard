import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { detectFormat, parseAny } from "./dispatch";
import { StatementParseError } from "./parsers/types";

function buildXlsx(header: unknown[], rows: unknown[][] = []): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("detectFormat", () => {
  it("recognizes the 4-column savings header", () => {
    const buf = buildXlsx(["Fecha", "Descripción", "Referencia", "Valor"]);
    expect(detectFormat(buf)).toEqual({
      bank: "bancolombia",
      format: "bancolombia_savings",
    });
  });

  it("recognizes the 6-column TC header", () => {
    const buf = buildXlsx([
      "Fecha",
      "Descripción",
      "Fecha de corte",
      "Valor",
      "Tipo de moneda",
      "Cuotas",
    ]);
    expect(detectFormat(buf)).toEqual({ bank: "bancolombia", format: "bancolombia_tc" });
  });

  it("tolerates trailing extra columns on savings (prefix match)", () => {
    const buf = buildXlsx(["Fecha", "Descripción", "Referencia", "Valor", "Extra"]);
    expect(detectFormat(buf)).toEqual({
      bank: "bancolombia",
      format: "bancolombia_savings",
    });
  });

  it("throws format_mismatch on a header that matches no known format", () => {
    const buf = buildXlsx(["Random", "Columns", "Here"]);
    try {
      detectFormat(buf);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StatementParseError);
      expect((err as StatementParseError).kind).toBe("format_mismatch");
    }
  });

  it("throws format_mismatch on mis-spelled savings column", () => {
    const buf = buildXlsx(["Fecha", "Descripcion", "Referencia", "Valor"]);
    try {
      detectFormat(buf);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StatementParseError);
      expect((err as StatementParseError).kind).toBe("format_mismatch");
    }
  });
});

describe("parseAny", () => {
  it("routes savings header to the savings parser", () => {
    const buf = buildXlsx(
      ["Fecha", "Descripción", "Referencia", "Valor"],
      [[46127, "x", null, 100]],
    );
    const { detected, parsed } = parseAny(buf);
    expect(detected.format).toBe("bancolombia_savings");
    expect(parsed.format).toBe("bancolombia_savings");
    expect(parsed.rowCount).toBe(1);
  });

  it("routes TC header to the TC parser", () => {
    const buf = buildXlsx(
      ["Fecha", "Descripción", "Fecha de corte", "Valor", "Tipo de moneda", "Cuotas"],
      [[46127, "y", null, 100, "COP", 1]],
    );
    const { detected, parsed } = parseAny(buf);
    expect(detected.format).toBe("bancolombia_tc");
    expect(parsed.format).toBe("bancolombia_tc");
    expect(parsed.rowCount).toBe(1);
  });
});
