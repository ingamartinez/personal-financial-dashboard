import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseBancolombiaSavingsExtracto } from "./bancolombia-savings-extracto";
import { detectFormat, parseAny } from "../dispatch";
import { StatementParseError } from "./types";

// ---------------------------------------------------------------------------
// Fixture builder helpers
// ---------------------------------------------------------------------------

type ExtractoRow = [
  string | null, // FECHA  (D/MM or DD/MM)
  string | null, // DESCRIPCIÓN
  string | null, // SUCURSAL
  string | null, // DCTO.
  string | null, // VALOR  (Colombian-formatted string)
  string | null, // SALDO  (Colombian-formatted string)
];

/**
 * Builds a synthetic Extracto Mensual XLSX buffer in the real Bancolombia
 * layout (title section rows 1-14, header at row 15, data from row 16 on).
 *
 * The period row uses `startDate` / `endDate` in "YYYY/MM/DD" format.
 */
function buildExtractoXlsx(
  opts: {
    startDate?: string; // e.g. "2025/12/31"
    endDate?: string; // e.g. "2026/03/31"
    rows?: ExtractoRow[];
    appendSentinel?: boolean;
  } = {},
): Buffer {
  const {
    startDate = "2026/01/01",
    endDate = "2026/03/31",
    rows = [],
    appendSentinel = true,
  } = opts;

  const titleSection: unknown[][] = [
    // r1: blank
    [null, null, null, null, null, null],
    // r2: info header
    ["Información Cliente:", null, null, null, null, null],
    // r3: labels
    ["CLIENTE", "DIRECCIÓN", "CIUDAD", null, null, null],
    // r4: data
    ["ALEJANDRO MARTINEZ", "CALLE 75 SUR 53 150", "ITAGUI ANTIOQUIA", null, null, null],
    // r5: blank
    [null, null, null, null, null, null],
    // r6: info header
    ["Información General:", null, null, null, null, null],
    // r7: labels
    ["DESDE", "HASTA", "TIPO CUENTA", "NRO CUENTA", "SUCURSAL", null],
    // r8: period data — this is where we read the start year
    [startDate, endDate, "CUENTA DE AHORROS", "9871936126", "SUCURSAL TEST", null],
    // r9: blank
    [null, null, null, null, null, null],
    // r10: resumen header
    ["Resumen:", null, null, null, null, null],
    // r11: summary labels
    ["SALDO ANTERIOR", "TOTAL ABONOS", "TOTAL CARGOS", "SALDO ACTUAL", null, null],
    // r12: summary values
    ["63,208.71", "28,882,641.87", "27,648,904.57", "1,296,946.01", null, null],
    // r13: blank
    [null, null, null, null, null, null],
    // r14: movimientos header
    ["Movimientos:", null, null, null, null, null],
    // r15: column header — row index 14 in 0-based matrix
    ["FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO"],
  ];

  const sentinel: unknown[][] = appendSentinel
    ? [[null, "FIN ESTADO DE CUENTA", null, null, null, null]]
    : [];

  const all: unknown[][] = [...titleSection, ...rows, ...sentinel];

  const ws = XLSX.utils.aoa_to_sheet(all);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Extracto");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ---------------------------------------------------------------------------
// detectFormat tests
// ---------------------------------------------------------------------------

describe("detectFormat — bancolombia_savings_extracto", () => {
  it("recognizes the 6-col Extracto header at row 15", () => {
    const buf = buildExtractoXlsx({
      rows: [["1/01", "ABONO INTERESES", null, null, ".08", "1,000.00"]],
    });
    expect(detectFormat(buf)).toEqual({
      bank: "bancolombia",
      format: "bancolombia_savings_extracto",
    });
  });

  it("recognizes the Extracto header even with garbage rows before it (header at row 18)", () => {
    // Build a sheet where title section is extended with extra garbage rows
    // so the header ends up later than row 15.
    const extraGarbage: unknown[][] = [
      ["Noise", null, null, null, null, null],
      ["More noise", null, null, null, null, null],
      [null, null, null, null, null, null],
    ];
    const titleSection: unknown[][] = [
      [null, null, null, null, null, null],
      ["Información Cliente:", null, null, null, null, null],
      ["CLIENTE", "DIRECCIÓN", "CIUDAD", null, null, null],
      ["ALEJANDRO", "CALLE", "ITAGUI", null, null, null],
      [null, null, null, null, null, null],
      ["Información General:", null, null, null, null, null],
      ["DESDE", "HASTA", "TIPO CUENTA", "NRO CUENTA", "SUCURSAL", null],
      ["2026/01/01", "2026/03/31", "CUENTA DE AHORROS", "6126", "SUCURSAL", null],
      [null, null, null, null, null, null],
      ["Resumen:", null, null, null, null, null],
      ["SALDO ANTERIOR", "TOTAL ABONOS", null, null, null, null],
      ["100.00", "200.00", null, null, null, null],
      [null, null, null, null, null, null],
      ["Movimientos:", null, null, null, null, null],
      ...extraGarbage,
      // header at row 18 (0-based index 17)
      ["FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO"],
      ["1/01", "ABONO INTERESES", null, null, ".08", "1,000.00"],
      [null, "FIN ESTADO DE CUENTA", null, null, null, null],
    ];
    const ws = XLSX.utils.aoa_to_sheet(titleSection);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Extracto");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectFormat(buf)).toEqual({
      bank: "bancolombia",
      format: "bancolombia_savings_extracto",
    });
  });

  it("does NOT mistake the 4-col savings format for extracto", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Fecha", "Descripción", "Referencia", "Valor"],
      [46127.20833, "x", null, 100],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectFormat(buf)).toEqual({ bank: "bancolombia", format: "bancolombia_savings" });
  });
});

// ---------------------------------------------------------------------------
// parseBancolombiaSavingsExtracto tests
// ---------------------------------------------------------------------------

describe("parseBancolombiaSavingsExtracto", () => {
  it("parses a basic fixture and returns the correct ParsedStatement shape", () => {
    const buf = buildExtractoXlsx({
      startDate: "2026/01/01",
      endDate: "2026/03/31",
      rows: [
        ["2/01", "PAGO DE PROV PEXTO COLOMBIA", null, null, "100,000.00", "141,383.46"],
        ["3/01", "COMPRA EN COLMEDICA", null, null, "-423,896.00", "5,716,868.66"],
        ["5/02", "ABONO INTERESES AHORROS", null, null, ".14", "52,573.65"],
      ],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.bank).toBe("bancolombia");
    expect(out.format).toBe("bancolombia_savings_extracto");
    expect(out.rowCount).toBe(3);
    expect(out.rows.every((r) => r.currency === "COP")).toBe(true);
    expect(out.rows.every((r) => r.isMetadata === false)).toBe(true);
  });

  it("correctly maps positive VALOR → direction='in', negative VALOR → direction='out'", () => {
    const buf = buildExtractoXlsx({
      rows: [
        ["2/01", "INGRESO", null, null, "100,000.00", "200,000.00"],
        ["3/01", "GASTO", null, null, "-50,000.00", "150,000.00"],
        ["4/01", "MICRO INGRESO", null, null, ".14", "150,000.14"],
        ["4/01", "MICRO GASTO", null, null, "-.07", "150,000.07"],
      ],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.rows[0].direction).toBe("in");
    expect(out.rows[0].amountCents).toBe(BigInt(10_000_000));
    expect(out.rows[1].direction).toBe("out");
    expect(out.rows[1].amountCents).toBe(BigInt(5_000_000));
    expect(out.rows[2].direction).toBe("in");
    expect(out.rows[2].amountCents).toBe(BigInt(14));
    expect(out.rows[3].direction).toBe("out");
    expect(out.rows[3].amountCents).toBe(BigInt(7));
  });

  it("derives the year from the DESDE campo and assigns it to all rows in a single-year file", () => {
    const buf = buildExtractoXlsx({
      startDate: "2026/01/01",
      endDate: "2026/03/31",
      rows: [
        ["15/01", "TX 1", null, null, "1,000.00", "1,000.00"],
        ["20/03", "TX 2", null, null, "2,000.00", "3,000.00"],
      ],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.rows[0].occurredAt.getUTCFullYear()).toBe(2026);
    expect(out.rows[0].occurredAt.getUTCMonth()).toBe(0); // January = 0
    expect(out.rows[0].occurredAt.getUTCDate()).toBe(15);
    expect(out.rows[1].occurredAt.getUTCFullYear()).toBe(2026);
    expect(out.rows[1].occurredAt.getUTCMonth()).toBe(2); // March = 2
    expect(out.rows[1].occurredAt.getUTCDate()).toBe(20);
  });

  it("advances the year when month wraps backward (Dec → Jan across year boundary)", () => {
    const buf = buildExtractoXlsx({
      startDate: "2025/12/31",
      endDate: "2026/03/31",
      rows: [
        ["12/12", "MANEJO TARJETA DEB", null, null, "-11,175.00", "52,033.71"],
        ["31/12", "AJUSTE INTERES AHORROS DB", null, null, "-.06", "41,383.41"],
        ["1/01", "ABONO INTERESES AHORROS", null, null, ".08", "41,383.49"],
        ["15/03", "PAGO QR NEWMEN", null, null, "-158,500.00", "56,573.51"],
      ],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    // Dec rows → 2025
    expect(out.rows[0].occurredAt.getUTCFullYear()).toBe(2025);
    expect(out.rows[0].occurredAt.getUTCMonth()).toBe(11); // December
    expect(out.rows[1].occurredAt.getUTCFullYear()).toBe(2025);
    expect(out.rows[1].occurredAt.getUTCMonth()).toBe(11); // December
    // Jan rows → 2026
    expect(out.rows[2].occurredAt.getUTCFullYear()).toBe(2026);
    expect(out.rows[2].occurredAt.getUTCMonth()).toBe(0); // January
    // March → 2026
    expect(out.rows[3].occurredAt.getUTCFullYear()).toBe(2026);
    expect(out.rows[3].occurredAt.getUTCMonth()).toBe(2); // March
  });

  it("sets occurredAt at midnight Bogotá (05:00 UTC)", () => {
    const buf = buildExtractoXlsx({
      rows: [["2/01", "TX", null, null, "1,000.00", "1,000.00"]],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.rows[0].occurredAt.getUTCHours()).toBe(5);
    expect(out.rows[0].occurredAt.getUTCMinutes()).toBe(0);
    expect(out.rows[0].occurredAt.getUTCSeconds()).toBe(0);
  });

  it("captures periodStart and periodEnd as min/max of row dates", () => {
    const buf = buildExtractoXlsx({
      startDate: "2026/01/01",
      endDate: "2026/03/31",
      rows: [
        ["15/01", "NEWEST", null, null, "1,000.00", "1,000.00"],
        ["2/01", "OLDEST", null, null, "2,000.00", "2,000.00"],
        ["10/01", "MIDDLE", null, null, "3,000.00", "3,000.00"],
      ],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.periodStart.getUTCDate()).toBe(2);
    expect(out.periodEnd.getUTCDate()).toBe(15);
  });

  it("captures balanceAtEndCents from the last SALDO value", () => {
    const buf = buildExtractoXlsx({
      rows: [
        ["2/01", "TX 1", null, null, "1,000.00", "100,000.00"],
        ["3/01", "TX 2", null, null, "-500.00", "1,296,946.01"],
      ],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    // Last SALDO is "1,296,946.01" → 129694601 cents
    expect(out.balanceAtEndCents).toBe(BigInt(129_694_601));
  });

  it("includes PAGO SUC VIRT TC MASTER DOLAR row with correct descriptionRaw", () => {
    const buf = buildExtractoXlsx({
      rows: [
        ["2/01", "PAGO SUC VIRT TC MASTER DOLAR", null, null, "-405,764.64", "3,111,909.02"],
        ["2/01", "PAGO SUC VIRT TC MASTER PESOS", null, null, "-2,199,195.00", "3,517,673.66"],
      ],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.rows[0].descriptionRaw).toBe("PAGO SUC VIRT TC MASTER DOLAR");
    expect(out.rows[0].direction).toBe("out");
    expect(out.rows[0].amountCents).toBe(BigInt(40_576_464));
    expect(out.rows[1].descriptionRaw).toBe("PAGO SUC VIRT TC MASTER PESOS");
    expect(out.rows[1].direction).toBe("out");
  });

  it("stops at FIN ESTADO DE CUENTA sentinel and excludes it from rows", () => {
    const buf = buildExtractoXlsx({
      rows: [["2/01", "TX 1", null, null, "1,000.00", "1,000.00"]],
      appendSentinel: true,
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.rowCount).toBe(1);
    expect(out.rows.every((r) => r.descriptionRaw !== "FIN ESTADO DE CUENTA")).toBe(true);
  });

  it("throws StatementParseError('empty') when there are no data rows", () => {
    const buf = buildExtractoXlsx({ rows: [], appendSentinel: false });
    expect(() => parseBancolombiaSavingsExtracto(buf)).toThrow(StatementParseError);
    try {
      parseBancolombiaSavingsExtracto(buf);
    } catch (err) {
      expect((err as StatementParseError).kind).toBe("empty");
    }
  });

  it("throws StatementParseError('format_mismatch') when the Extracto header is missing", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["RANDOM", "HEADERS", "HERE", null, null, null],
      ["data", "data", "data", null, null, null],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Extracto");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(() => parseBancolombiaSavingsExtracto(buf)).toThrow(StatementParseError);
    try {
      parseBancolombiaSavingsExtracto(buf);
    } catch (err) {
      expect((err as StatementParseError).kind).toBe("format_mismatch");
    }
  });

  it("throws StatementParseError('bad_row') on an invalid FECHA value", () => {
    const buf = buildExtractoXlsx({
      rows: [["NOT_A_DATE", "TX 1", null, null, "1,000.00", "1,000.00"]],
      appendSentinel: false,
    });
    expect(() => parseBancolombiaSavingsExtracto(buf)).toThrow(StatementParseError);
    try {
      parseBancolombiaSavingsExtracto(buf);
    } catch (err) {
      expect((err as StatementParseError).kind).toBe("bad_row");
    }
  });

  it("stores sucursal and dcto metadata in rawData", () => {
    const buf = buildExtractoXlsx({
      rows: [["5/01", "COMPRA EN TIENDA", "SUCURSAL NORTE", "TXN-001", "-50,000.00", "50,000.00"]],
    });
    const out = parseBancolombiaSavingsExtracto(buf);
    expect(out.rows[0].rawData.sucursal).toBe("SUCURSAL NORTE");
    expect(out.rows[0].rawData.dcto).toBe("TXN-001");
  });

  it("parses multi-section files where Bancolombia concatenates per-cycle blocks", () => {
    // Real Bancolombia exports spanning multiple cycles concatenate one
    // section per cycle, each starting with "Información Cliente:" → cliente
    // → "Información General:" → period → "Movimientos:" → header → data.
    // The parser must skip the section break and resume at the next header.
    const titleSection: unknown[][] = [
      [null, null, null, null, null, null],
      ["Información Cliente:", null, null, null, null, null],
      ["CLIENTE", "DIRECCIÓN", "CIUDAD", null, null, null],
      ["ALEJANDRO MARTINEZ", "CALLE 75", "ITAGUI", null, null, null],
      [null, null, null, null, null, null],
      ["Información General:", null, null, null, null, null],
      ["DESDE", "HASTA", "TIPO CUENTA", "NRO CUENTA", "SUCURSAL", null],
      ["2026/01/01", "2026/03/31", "CUENTA DE AHORROS", "9871936126", "SUC TEST", null],
      [null, null, null, null, null, null],
      ["Resumen:", null, null, null, null, null],
      ["SALDO ANT", "ABONOS", "CARGOS", "ACTUAL", null, null],
      ["1000.00", "5000.00", "2000.00", "4000.00", null, null],
      [null, null, null, null, null, null],
      ["Movimientos:", null, null, null, null, null],
      ["FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO"],
    ];

    const section1Data: unknown[][] = [
      ["2/01", "TX A SECTION 1", null, null, "1,000.00", "1,000.00"],
      ["3/01", "TX B SECTION 1", null, null, "-200.00", "800.00"],
    ];

    // Section break: same shape as a fresh section starting with cliente info
    const sectionBreak: unknown[][] = [
      ["Información Cliente:", null, null, null, null, null],
      ["CLIENTE", "DIRECCIÓN", "CIUDAD", null, null, null],
      ["ALEJANDRO MARTINEZ", "CALLE 75", "ITAGUI", null, null, null],
      [null, null, null, null, null, null],
      ["Información General:", null, null, null, null, null],
      ["DESDE", "HASTA", "TIPO CUENTA", "NRO CUENTA", "SUCURSAL", null],
      ["2026/02/01", "2026/02/28", "CUENTA DE AHORROS", "9871936126", "SUC TEST", null],
      [null, null, null, null, null, null],
      ["Movimientos:", null, null, null, null, null],
      ["FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO"],
    ];

    const section2Data: unknown[][] = [
      ["1/02", "TX C SECTION 2", null, null, "500.00", "1,300.00"],
      ["14/03", "PAGO SUC VIRT TC MASTER DOLAR", null, null, "-381,147.38", "-379,847.38"],
    ];

    const all: unknown[][] = [
      ...titleSection,
      ...section1Data,
      ...sectionBreak,
      ...section2Data,
      [null, "FIN ESTADO DE CUENTA", null, null, null, null],
    ];

    const ws = XLSX.utils.aoa_to_sheet(all);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Extracto");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const out = parseBancolombiaSavingsExtracto(buf);

    // Both sections' data rows present, section break excluded
    expect(out.rowCount).toBe(4);
    expect(out.rows.map((r) => r.descriptionRaw)).toEqual([
      "TX A SECTION 1",
      "TX B SECTION 1",
      "TX C SECTION 2",
      "PAGO SUC VIRT TC MASTER DOLAR",
    ]);

    // Section 2's PAGO row must be picked up correctly — this is the case
    // that the prod Extracto file hit in 2026-04-27.
    const pago = out.rows[3];
    expect(pago.direction).toBe("out");
    expect(pago.amountCents).toBe(BigInt(38_114_738));
    expect(pago.occurredAt.toISOString()).toBe("2026-03-14T05:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// parseAny integration tests
// ---------------------------------------------------------------------------

describe("parseAny — routes Extracto to extracto parser", () => {
  it("routes Extracto buffer to bancolombia_savings_extracto parser", () => {
    const buf = buildExtractoXlsx({
      rows: [["2/01", "ABONO INTERESES", null, null, ".08", "1,000.00"]],
    });
    const { detected, parsed } = parseAny(buf);
    expect(detected.format).toBe("bancolombia_savings_extracto");
    expect(parsed.format).toBe("bancolombia_savings_extracto");
    expect(parsed.bank).toBe("bancolombia");
    expect(parsed.rowCount).toBe(1);
  });

  it("does not break existing 4-col savings routing", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Fecha", "Descripción", "Referencia", "Valor"],
      [46127, "x", null, 100],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const { detected, parsed } = parseAny(buf);
    expect(detected.format).toBe("bancolombia_savings");
    expect(parsed.format).toBe("bancolombia_savings");
  });
});
