import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  parseBancolombiaStatement,
  parseCopAmount,
  parseCuotas,
  parsePeriod,
  parseRateEmX10k,
  parseSpanishDate,
  parseStatementDate,
} from "./xlsx";

// -----------------------------------------------------------------------------
// Scalar parsers
// -----------------------------------------------------------------------------

describe("parseCopAmount", () => {
  it("parses COP locale (dot thousands, comma decimal)", () => {
    expect(parseCopAmount("7.744.665,00")).toBe(BigInt(774466500));
    expect(parseCopAmount("79.918,36")).toBe(BigInt(7991836));
    expect(parseCopAmount("4.176.921,00")).toBe(BigInt(417692100));
    expect(parseCopAmount("135.317,35")).toBe(BigInt(13531735));
  });

  it("parses US locale (comma thousands, dot decimal)", () => {
    expect(parseCopAmount("4,351,431.00")).toBe(BigInt(435143100));
    expect(parseCopAmount("1,000.00")).toBe(BigInt(100000));
  });

  it("parses values with single separator acting as decimal", () => {
    expect(parseCopAmount("0,00")).toBe(BigInt(0));
    expect(parseCopAmount("0.00")).toBe(BigInt(0));
    expect(parseCopAmount("12,5")).toBe(BigInt(1250)); // 12.5 → 1250 cents
  });

  it("handles negative values for pagos / abonos", () => {
    expect(parseCopAmount("-4.176.921,00")).toBe(-BigInt(417692100));
  });

  it("strips leading currency tokens", () => {
    expect(parseCopAmount("COP1.000,00")).toBe(BigInt(100000));
    expect(parseCopAmount("$1.000,00")).toBe(BigInt(100000));
  });

  it("accepts plain numeric input", () => {
    expect(parseCopAmount(1234)).toBe(BigInt(123400));
  });

  it("throws on empty / non-numeric input", () => {
    expect(() => parseCopAmount("")).toThrow();
    expect(() => parseCopAmount("abc")).toThrow();
  });
});

describe("parseRateEmX10k", () => {
  it("parses comma decimal rate (row table format)", () => {
    expect(parseRateEmX10k("1,8895")).toBe(18895);
    expect(parseRateEmX10k("1,8311")).toBe(18311);
    expect(parseRateEmX10k("0,0000")).toBe(0);
  });

  it("parses dot decimal rate with percent suffix (summary format)", () => {
    expect(parseRateEmX10k("1.9110 %")).toBe(19110);
    expect(parseRateEmX10k("0.0000 %")).toBe(0);
    expect(parseRateEmX10k("25.5026 %")).toBe(255026);
  });

  it("returns null for empty / nullish input", () => {
    expect(parseRateEmX10k("")).toBeNull();
    expect(parseRateEmX10k(null)).toBeNull();
    expect(parseRateEmX10k(undefined)).toBeNull();
  });
});

describe("parseCuotas", () => {
  it("parses N/total", () => {
    expect(parseCuotas("1/1")).toEqual({ paid: 1, total: 1 });
    expect(parseCuotas("2/6")).toEqual({ paid: 2, total: 6 });
    expect(parseCuotas("3/12")).toEqual({ paid: 3, total: 12 });
  });

  it("returns null for empty / nullish input", () => {
    expect(parseCuotas("")).toBeNull();
    expect(parseCuotas(null)).toBeNull();
  });

  it("throws on malformed values", () => {
    expect(() => parseCuotas("abc")).toThrow();
    expect(() => parseCuotas("1/0")).toThrow();
    expect(() => parseCuotas("5/2")).toThrow(); // paid > total
  });
});

describe("parseStatementDate", () => {
  it("parses DD/MM/YYYY", () => {
    const d = parseStatementDate("30/03/2026");
    expect(d.toISOString()).toBe("2026-03-30T00:00:00.000Z");
  });

  it("throws on invalid formats", () => {
    expect(() => parseStatementDate("2026-03-30")).toThrow();
    expect(() => parseStatementDate("30/13/2026")).toThrow();
  });
});

describe("parseSpanishDate", () => {
  it("parses 'mmm D, YYYY'", () => {
    const d = parseSpanishDate("abr. 16, 2026");
    expect(d.toISOString()).toBe("2026-04-16T00:00:00.000Z");
  });

  it("parses 'D mmm YYYY'", () => {
    const d = parseSpanishDate("30 mar. 2026");
    expect(d.toISOString()).toBe("2026-03-30T00:00:00.000Z");
  });

  it("throws on unknown month abbreviations", () => {
    expect(() => parseSpanishDate("xxx 16 2026")).toThrow();
  });
});

describe("parsePeriod", () => {
  it("infers start year from end year when start has no year", () => {
    const { startDate, endDate } = parsePeriod("28 feb", "30 mar. 2026");
    expect(startDate.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-03-30T00:00:00.000Z");
  });

  it("rolls start year back when period crosses calendar boundary", () => {
    const { startDate, endDate } = parsePeriod("28 dic", "27 ene. 2026");
    expect(startDate.toISOString()).toBe("2025-12-28T00:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-01-27T00:00:00.000Z");
  });

  it("honors explicit year when present on start", () => {
    const { startDate } = parsePeriod("28 feb. 2025", "30 mar. 2026");
    expect(startDate.toISOString()).toBe("2025-02-28T00:00:00.000Z");
  });
});

// -----------------------------------------------------------------------------
// End-to-end: synthetic xlsx fixture we build in-memory.
// Runs in CI — the real fixture at .private/statements/ is gitignored.
// -----------------------------------------------------------------------------

function buildSyntheticSheet(): Buffer {
  const aoa: (string | number | null)[][] = [
    ["Información Cliente:"],
    ["Cliente", null, "Dirección", "Ciudad", "Departamento"],
    ["TEST USER", null, "CALLE 1", "MEDELLIN", "ANTIOQUIA"],
    [],
    ["Información de la Tarjeta", "************9999"],
    ["Moneda: ", "PESOS"],
    [],
    ["Periodo facturado: ", "01 ene", "31 ene. 2026"],
    ["Pagar antes de: ", "feb. 15, 2026"],
    ["Pago mínimo", "100.000,00"],
    ["Pago total", "500.000,00"],
    ["Cupo total: ", "1.000.000,00"],
    ["Cupo disponible: ", "500.000,00"],
    [],
    [],
    [
      "Tasas de interés vigente",
      "Tasa Mes Vencido",
      "Tasa Efectivo Anual",
      "Resumen Saldo Total",
      "",
      "Resumen Pago Mínimo",
    ],
    [],
    [
      "Compra un mes",
      "0.0000 %",
      "0.0000 %",
      "+ Saldo anterior",
      "300.000,00",
      "Cuota transacciones",
      "50.000,00",
    ],
    [
      "Compra 2 - 36 meses",
      "1.9110 %",
      "25.5026 %",
      "+ Compras del mes",
      "250.000,00",
      "Cuota Transacciones anteriores",
      "0,00",
    ],
    ["Impuestos", "1.9110 %", "25.5026 %", "+ Intereses de mora", "0,00", "Cuota avances", "0,00"],
    [
      "Avances",
      "1.9110 %",
      "25.5026 %",
      "+ Intereses corrientes",
      "5.000,00",
      "+ Intereses de mora",
      "0,00",
    ],
    ["Mora", "1.9110 %", "25.5026 %", "+ Avances", "0,00", "+ Intereses corrientes", "5.000,00"],
    [null, null, null, "+ Otros cargos", "0,00"],
    [null, null, null, "Cargos", "555.000,00"],
    [null, null, null, "(-) Pagos / abonos", "100.000,00"],
    [null, null, null, "(-) Saldo a favor", "0,00"],
    [null, null, null, "Abono", "100.000,00"],
    [],
    [],
    ["Movimientos durante el periodo"],
    [
      "Número de autorización",
      "Fecha",
      "Movimientos",
      "Valor Movimiento",
      "Número de cuotas",
      "Valor cuota/abono",
      "Interés mensual (%)",
      "Interés anual (%)",
      "Saldo pendiente",
    ],
    ["", "31/01/2026", "INTERESES CORRIENTES", "5.000,00", "", "5.000,00", "", "", "0,00"],
    [
      "111111",
      "20/01/2026",
      "TEST MERCHANT A",
      "50.000,00",
      "1/1",
      "50.000,00",
      "0,0000",
      "00,0000",
      "0,00",
    ],
    [
      "222222",
      "15/01/2026",
      "TEST MERCHANT B",
      "200.000,00",
      "1/4",
      "50.000,00",
      "1,9110",
      "25,5026",
      "150.000,00",
    ],
    ["333333", "10/01/2026", "ABONO PAGO", "-100.000,00", "", "-100.000,00", "", "", "0,00"],
    [],
    ["Movimientos antes del periodo"],
    [
      "Número de autorización",
      "Fecha",
      "Movimientos",
      "Valor Movimiento",
      "Número de cuotas",
      "Valor cuota/abono",
      "Interés mensual (%)",
      "Interés anual (%)",
      "Saldo pendiente",
    ],
    [
      "444444",
      "15/12/2025",
      "OLD MERCHANT",
      "100.000,00",
      "2/6",
      "16.666,67",
      "1,8311",
      "24,3269",
      "66.666,68",
    ],
  ];

  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, sheet, "PESOS");
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
  return Buffer.from(buf);
}

describe("parseBancolombiaStatement (synthetic fixture)", () => {
  const parsed = parseBancolombiaStatement(buildSyntheticSheet());

  it("extracts account metadata", () => {
    expect(parsed.account).toEqual({ last4: "9999", currency: "COP" });
  });

  it("extracts period with inferred start year", () => {
    expect(parsed.period.startDate.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.period.endDate.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(parsed.period.dueDate.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("extracts summary values", () => {
    expect(parsed.summary.previousBalanceCents).toBe(BigInt(30000000));
    expect(parsed.summary.purchasesCents).toBe(BigInt(25000000));
    expect(parsed.summary.interestCorrientesCents).toBe(BigInt(500000));
    expect(parsed.summary.paymentsCents).toBe(BigInt(10000000));
    expect(parsed.summary.minPaymentCents).toBe(BigInt(10000000));
    expect(parsed.summary.totalPaymentCents).toBe(BigInt(50000000));
  });

  it("extracts current rates", () => {
    expect(parsed.currentRates).toEqual({
      oneMonth: 0,
      months2to36: 19110,
      advances: 19110,
    });
  });

  it("extracts rows with correct kinds and sign conventions", () => {
    expect(parsed.rows).toHaveLength(5);
    const during = parsed.rows.filter((r) => r.kind === "during-period");
    const before = parsed.rows.filter((r) => r.kind === "before-period");
    expect(during).toHaveLength(4);
    expect(before).toHaveLength(1);

    const interestRow = during[0];
    expect(interestRow.merchant).toBe("INTERESES CORRIENTES");
    expect(interestRow.authorizationNumber).toBeNull();
    expect(interestRow.amountCents).toBe(BigInt(500000));
    expect(interestRow.installments).toBeNull();
    expect(interestRow.rateEmX10k).toBeNull();

    const abonoRow = during.find((r) => r.merchant === "ABONO PAGO");
    expect(abonoRow?.amountCents).toBe(-BigInt(10000000));
    expect(abonoRow?.authorizationNumber).toBe("333333");

    const multiCuotaRow = during.find((r) => r.merchant === "TEST MERCHANT B");
    expect(multiCuotaRow?.installments).toEqual({ paid: 1, total: 4 });
    expect(multiCuotaRow?.rateEmX10k).toBe(19110);
    expect(multiCuotaRow?.saldoPendingCents).toBe(BigInt(15000000));

    const beforeRow = before[0];
    expect(beforeRow.merchant).toBe("OLD MERCHANT");
    expect(beforeRow.rateEmX10k).toBe(18311);
  });
});

describe("parseBancolombiaStatement (malformed input)", () => {
  it("rejects non-xlsx / empty buffer with explicit error", () => {
    // SheetJS is tolerant and may treat random bytes as an empty workbook, so
    // the parser bails at the "no extracto metadata" step instead of at load
    // time. Either way the error is explicit and prefixed.
    expect(() => parseBancolombiaStatement(Buffer.from("not an xlsx"))).toThrow(
      /parseBancolombiaStatement/,
    );
  });

  it("rejects xlsx missing the 'Información de la Tarjeta' row", () => {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["Nothing useful here"]]);
    XLSX.utils.book_append_sheet(wb, sheet, "PESOS");
    const buf = Buffer.from(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
    expect(() => parseBancolombiaStatement(buf)).toThrow(/información de la tarjeta/i);
  });
});

// -----------------------------------------------------------------------------
// Integration test against the real extracto fixture — opt-in because the
// file lives in .private/ (gitignored) and is absent in CI.
// -----------------------------------------------------------------------------

const FIXTURE_PATH = resolve(
  process.cwd(),
  ".private/statements/Extracto_202603_Visa_Detallado_2575.xlsx",
);

const describeIfFixture = existsSync(FIXTURE_PATH) ? describe : describe.skip;

describeIfFixture("parseBancolombiaStatement (real fixture 202603 Visa 2575)", () => {
  const parsed = parseBancolombiaStatement(readFileSync(FIXTURE_PATH));

  it("extracts account last4 + currency", () => {
    expect(parsed.account).toEqual({ last4: "2575", currency: "COP" });
  });

  it("extracts period 2026-02-28 → 2026-03-30 due 2026-04-16", () => {
    expect(parsed.period.startDate.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(parsed.period.endDate.toISOString()).toBe("2026-03-30T00:00:00.000Z");
    expect(parsed.period.dueDate.toISOString()).toBe("2026-04-16T00:00:00.000Z");
  });

  it("matches acceptance summary values (issue #417)", () => {
    expect(parsed.summary.interestCorrientesCents).toBe(BigInt(7991836));
    expect(parsed.summary.paymentsCents).toBe(BigInt(417692100));
    expect(parsed.summary.previousBalanceCents).toBe(BigInt(824037652));
    expect(parsed.summary.purchasesCents).toBe(BigInt(360129100));
    expect(parsed.summary.minPaymentCents).toBe(BigInt(435143100));
    expect(parsed.summary.totalPaymentCents).toBe(BigInt(774466500));
  });

  it("matches acceptance rate (2-36 meses === 19110)", () => {
    expect(parsed.currentRates.months2to36).toBe(19110);
    expect(parsed.currentRates.advances).toBe(19110);
    expect(parsed.currentRates.oneMonth).toBe(0);
  });

  it("extracts 55+ rows (acceptance minimum)", () => {
    expect(parsed.rows.length).toBeGreaterThanOrEqual(55);
  });

  it("captures the synthetic INTERESES CORRIENTES row (no auth, null rate)", () => {
    const row = parsed.rows.find((r) => r.merchant === "INTERESES CORRIENTES");
    expect(row).toBeDefined();
    expect(row?.authorizationNumber).toBeNull();
    expect(row?.amountCents).toBe(BigInt(7991836));
    expect(row?.rateEmX10k).toBeNull();
  });

  it("captures the ABONO SUCURSAL VIRTUAL with negative amount", () => {
    const row = parsed.rows.find((r) => r.merchant === "ABONO SUCURSAL VIRTUAL");
    expect(row).toBeDefined();
    expect(row?.amountCents).toBe(-BigInt(417692100));
    expect(row?.authorizationNumber).toBe("202676");
  });

  it("splits rows between during-period and before-period", () => {
    const during = parsed.rows.filter((r) => r.kind === "during-period");
    const before = parsed.rows.filter((r) => r.kind === "before-period");
    expect(during.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
    expect(during.length + before.length).toBe(parsed.rows.length);
  });

  it("preserves multi-cuota installment metadata on before-period rows", () => {
    const row = parsed.rows.find((r) => r.merchant === "AIRBNB * HMRPPHENMF");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("before-period");
    expect(row?.installments).toEqual({ paid: 2, total: 2 });
    expect(row?.rateEmX10k).toBe(18895);
    expect(row?.amountCents).toBe(BigInt(24650000));
  });
});
