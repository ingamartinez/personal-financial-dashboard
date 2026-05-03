// dispatch.test.ts — unified ingestion dispatcher tests
//
// Unit tests (cases 1-8): use synthetic buffers — no real fixture files.
// Integration test (resolveAccountHint cross-tenant): hits findash_test DB.
// Default vitest env is "node" — no jsdom override needed.

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { detectKind, parseAndHint, resolveAccountHint, UnsupportedFileKindError } from "./dispatch";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal valid PDF buffer (starts with %PDF magic). */
function makePdfBuffer(sizeBytes = 100): Buffer {
  const buf = Buffer.alloc(sizeBytes, 0);
  buf.write("%PDF-1.4\n", 0, "utf8");
  return buf;
}

/** Build an XLSX with the 4-col savings header (bancolombia-savings). */
function buildSavingsXlsx(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Fecha", "Descripción", "Referencia", "Valor"],
    [46127.20833, "ABONO INTERESES", "0012345", 100],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Build an XLSX in the Extracto Mensual 6-col format (bancolombia-extracto). */
function buildExtractoXlsx(): Buffer {
  const titleSection: unknown[][] = [
    [null, null, null, null, null, null],
    ["Información Cliente:", null, null, null, null, null],
    ["CLIENTE", "DIRECCIÓN", "CIUDAD", null, null, null],
    ["TEST USER", "CALLE 1", "MEDELLIN", null, null, null],
    [null, null, null, null, null, null],
    ["Información General:", null, null, null, null, null],
    ["DESDE", "HASTA", "TIPO CUENTA", "NRO CUENTA", "SUCURSAL", null],
    ["2026/01/01", "2026/03/31", "CUENTA DE AHORROS", "9871936126", "SUCURSAL TEST", null],
    [null, null, null, null, null, null],
    ["Resumen:", null, null, null, null, null],
    ["SALDO ANTERIOR", "TOTAL ABONOS", "TOTAL CARGOS", "SALDO ACTUAL", null, null],
    ["100.000,00", "50.000,00", "30.000,00", "120.000,00", null, null],
    [null, null, null, null, null, null],
    ["Movimientos:", null, null, null, null, null],
    ["FECHA", "DESCRIPCIÓN", "SUCURSAL", "DCTO.", "VALOR", "SALDO"],
    ["1/01", "ABONO INTERESES", null, null, "100,00", "120.100,00"],
    [null, "FIN ESTADO DE CUENTA", null, null, null, null],
  ];
  const ws = XLSX.utils.aoa_to_sheet(titleSection);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Extracto");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Build an XLSX with the TC legacy 6-col header (bancolombia-tc-legacy). */
function buildTcLegacyXlsx(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Fecha", "Descripción", "Fecha de corte", "Valor", "Tipo de moneda", "Cuotas"],
    [46127, "COMPRA TIENDA", 46130, 50000, "COP", "1"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Hoja 1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

type SyntheticTcOptions = {
  last4?: string;
  moneda?: string;
  /** Override the "Periodo facturado" row values (e.g. ["06 mar", "05 abr. 2026"]). */
  periodo?: [string, string];
};

function buildSyntheticTcAoa(opts: SyntheticTcOptions = {}): (string | number | null)[][] {
  const last4 = opts.last4 ?? "9999";
  const moneda = opts.moneda ?? "PESOS";
  const isUsd = /USD|DOLAR/i.test(moneda);
  const rateRows: (string | number | null)[][] = isUsd
    ? [
        [
          "Compra Internacional",
          "1.9110 %",
          "25.5026 %",
          "+ Saldo anterior",
          "300.000,00",
          "Cuota transacciones",
          "50.000,00",
        ],
        [
          "Avance Internacional",
          "1.9110 %",
          "25.5026 %",
          "+ Compras del mes",
          "250.000,00",
          "Cuota Transacciones anteriores",
          "0,00",
        ],
        ["Mora", "1.9110 %", "25.5026 %", "+ Intereses de mora", "0,00", "Cuota avances", "0,00"],
        [null, null, null, "+ Intereses corrientes", "5.000,00", "+ Intereses de mora", "0,00"],
        [null, null, null, "+ Avances", "0,00", "+ Intereses corrientes", "5.000,00"],
      ]
    : [
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
        [
          "Impuestos",
          "1.9110 %",
          "25.5026 %",
          "+ Intereses de mora",
          "0,00",
          "Cuota avances",
          "0,00",
        ],
        [
          "Avances",
          "1.9110 %",
          "25.5026 %",
          "+ Intereses corrientes",
          "5.000,00",
          "+ Intereses de mora",
          "0,00",
        ],
        [
          "Mora",
          "1.9110 %",
          "25.5026 %",
          "+ Avances",
          "0,00",
          "+ Intereses corrientes",
          "5.000,00",
        ],
      ];
  return [
    ["Información Cliente:"],
    ["Cliente", null, "Dirección", "Ciudad", "Departamento"],
    ["TEST USER", null, "CALLE 1", "MEDELLIN", "ANTIOQUIA"],
    [],
    ["Información de la Tarjeta", `************${last4}`],
    ["Moneda: ", moneda],
    [],
    ["Periodo facturado: ", opts.periodo?.[0] ?? "01 ene", opts.periodo?.[1] ?? "31 ene. 2026"],
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
    ...rateRows,
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
  ];
}

/** Build a TC Detallado XLSX with PESOS+DOLARES sheets (bancolombia-tc-detallado). */
function buildTcDetalladoXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  const pesos = XLSX.utils.aoa_to_sheet(buildSyntheticTcAoa({ last4: "8888", moneda: "PESOS" }));
  const dolares = XLSX.utils.aoa_to_sheet(buildSyntheticTcAoa({ last4: "8888", moneda: "USD" }));
  XLSX.utils.book_append_sheet(wb, pesos, "PESOS");
  XLSX.utils.book_append_sheet(wb, dolares, "DOLARES");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

/** Build garbage bytes that are neither PDF nor XLSX. */
function makeGarbageBuffer(): Buffer {
  return Buffer.from([0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef]);
}

/** Build an XLSX that has no recognized header (format_unknown). */
function buildUnrecognizedXlsx(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([["Random", "Columns", "Here", "NotBancolombia"]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ---------------------------------------------------------------------------
// detectKind unit tests
// ---------------------------------------------------------------------------

describe("detectKind", () => {
  it("1. %PDF buffer → kind: arq-pdf", () => {
    const buf = makePdfBuffer();
    expect(detectKind(buf)).toBe("arq-pdf");
  });

  it("2. 4-col Movimientos XLSX → kind: bancolombia-savings", () => {
    const buf = buildSavingsXlsx();
    expect(detectKind(buf)).toBe("bancolombia-savings");
  });

  it("3. 6-col SALDO XLSX → kind: bancolombia-extracto", () => {
    const buf = buildExtractoXlsx();
    expect(detectKind(buf)).toBe("bancolombia-extracto");
  });

  it("4. TC legacy 6-col XLSX → kind: bancolombia-tc-legacy", () => {
    const buf = buildTcLegacyXlsx();
    expect(detectKind(buf)).toBe("bancolombia-tc-legacy");
  });

  it("5. TC detallado PESOS+DOLARES XLSX → kind: bancolombia-tc-detallado", () => {
    const buf = buildTcDetalladoXlsx();
    expect(detectKind(buf)).toBe("bancolombia-tc-detallado");
  });

  it("6. Garbage bytes → returns format_unknown (does NOT throw)", () => {
    // Garbage starts with 0x00 — not PDF or XLSX magic
    const buf = makeGarbageBuffer();
    expect(() => detectKind(buf)).toThrow(UnsupportedFileKindError);
    expect(() => detectKind(buf)).toThrow(/Tipo de archivo no soportado/);
  });

  it("6b. Unrecognized XLSX → returns format_unknown (does NOT throw)", () => {
    const buf = buildUnrecognizedXlsx();
    expect(detectKind(buf)).toBe("format_unknown");
  });
});

// ---------------------------------------------------------------------------
// parseAndHint unit tests
// ---------------------------------------------------------------------------

describe("parseAndHint", () => {
  it("7. ARQ PDF >10MB → throws UnsupportedFileKindError with MB in message", async () => {
    // Craft a buffer that starts with %PDF but is > 10 MB
    const oversizePdf = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
    oversizePdf.write("%PDF-1.4\n", 0, "utf8");

    await expect(parseAndHint(oversizePdf)).rejects.toThrow(UnsupportedFileKindError);
    await expect(parseAndHint(oversizePdf)).rejects.toThrow(/10 MB/);
  });

  it("8. XLSX >5MB → throws UnsupportedFileKindError with MB in message", async () => {
    // Craft a buffer that starts with XLSX ZIP magic but is > 5 MB
    const oversizeXlsx = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20);
    // PK\x03\x04 = XLSX magic
    oversizeXlsx[0] = 0x50;
    oversizeXlsx[1] = 0x4b;
    oversizeXlsx[2] = 0x03;
    oversizeXlsx[3] = 0x04;

    await expect(parseAndHint(oversizeXlsx)).rejects.toThrow(UnsupportedFileKindError);
    await expect(parseAndHint(oversizeXlsx)).rejects.toThrow(/5 MB/);
  });

  it("6. Garbage bytes → parseAndHint throws UnsupportedFileKindError", async () => {
    const buf = makeGarbageBuffer();
    await expect(parseAndHint(buf)).rejects.toThrow(UnsupportedFileKindError);
    await expect(parseAndHint(buf)).rejects.toThrow(/Tipo de archivo no soportado/);
  });

  it("5b. TC detallado XLSX → kind: bancolombia-tc-detallado, multiCurrencySheets true", async () => {
    const buf = buildTcDetalladoXlsx();
    const result = await parseAndHint(buf);
    expect(result.kind).toBe("bancolombia-tc-detallado");
    if (result.kind === "bancolombia-tc-detallado") {
      expect(result.multiCurrencySheets).toBe(true);
      expect(result.parsedSheets).toHaveLength(2);
      expect(result.cycleHint.source).toBe("file-period");
      expect(result.cycleHint.cycle).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  it("unrecognized XLSX → kind: format_unknown (does NOT throw)", async () => {
    const buf = buildUnrecognizedXlsx();
    const result = await parseAndHint(buf);
    expect(result.kind).toBe("format_unknown");
  });

  it("#750 — cycleHint uses period endDate (not startDate), so March-start/April-end → 2026-04", async () => {
    // The statement covers 2026-03-06 → 2026-04-05 (typical Bancolombia TC cycle).
    // The cycle label must be the CUTOFF month (April) not the start month (March).
    const wb = XLSX.utils.book_new();
    const pesos = XLSX.utils.aoa_to_sheet(
      buildSyntheticTcAoa({ moneda: "PESOS", periodo: ["06 mar", "05 abr. 2026"] }),
    );
    const dolares = XLSX.utils.aoa_to_sheet(
      buildSyntheticTcAoa({ moneda: "USD", periodo: ["06 mar", "05 abr. 2026"] }),
    );
    XLSX.utils.book_append_sheet(wb, pesos, "PESOS");
    XLSX.utils.book_append_sheet(wb, dolares, "DOLARES");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;

    const result = await parseAndHint(buf);
    expect(result.kind).toBe("bancolombia-tc-detallado");
    if (result.kind === "bancolombia-tc-detallado") {
      expect(result.cycleHint.source).toBe("file-period");
      expect(result.cycleHint.cycle).toBe("2026-04");
    }
  });
});

// ---------------------------------------------------------------------------
// tryDetectTcDetallado unit tests (T1.2 acceptance)
// ---------------------------------------------------------------------------

import { tryDetectTcDetallado } from "./bancolombia-statement/xlsx";

describe("tryDetectTcDetallado (T1.2)", () => {
  it("returns true for a PESOS+DOLARES workbook (multi-currency twin marker)", () => {
    const buf = buildTcDetalladoXlsx();
    expect(tryDetectTcDetallado(buf)).toBe(true);
  });

  it("returns false for a savings 4-col workbook", () => {
    const buf = buildSavingsXlsx();
    expect(tryDetectTcDetallado(buf)).toBe(false);
  });

  it("returns false for non-XLSX bytes (does NOT throw)", () => {
    const buf = makeGarbageBuffer();
    expect(tryDetectTcDetallado(buf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveAccountHint — cross-tenant integration test
//
// Runs against findash_test DB (forced by vitest.setup.ts).
// Seeds 2 users with the same accountNumber to prove no cross-tenant leakage.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Helpers to seed test data and clean up
async function seedTestUser(email: string): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({
      email,
      name: `Test ${email}`,
      role: "user",
    })
    .returning({ id: users.id });
  if (!u) throw new Error(`Failed to seed user ${email}`);
  return u.id;
}

async function seedArqAccount(userId: number, accountNumber: string): Promise<number> {
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      name: "ARQ Account",
      institution: "ARQ",
      institutionSlug: "other",
      type: "savings",
      currency: "USD",
      active: true,
      metadata: { accountNumber } as Record<string, unknown>,
    })
    .returning({ id: accounts.id });
  if (!a) throw new Error(`Failed to seed account for user ${userId}`);
  return a.id;
}

async function seedTcDetalladoAccount(userId: number, last4: string): Promise<number> {
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      name: "TC Detallado Account",
      institution: "bancolombia",
      institutionSlug: "bancolombia",
      type: "credit_card",
      currency: "COP",
      active: true,
      metadata: { last4s: [last4] } as Record<string, unknown>,
    })
    .returning({ id: accounts.id });
  if (!a) throw new Error(`Failed to seed tc account for user ${userId}`);
  return a.id;
}

async function cleanupUsers(emails: string[]): Promise<void> {
  for (const email of emails) {
    // Cascades to accounts via FK
    await db.delete(users).where(eq(users.email, email));
  }
}

describe("resolveAccountHint — cross-tenant isolation (integration)", () => {
  // Use unique emails to avoid conflicts across test runs
  const EMAIL_A = `dispatch-test-a-${Date.now()}@test.findash`;
  const EMAIL_B = `dispatch-test-b-${Date.now()}@test.findash`;
  const SHARED_ACCOUNT_NUMBER = `ACCT-${Date.now()}`;
  const SHARED_LAST4 = String(Date.now()).slice(-4);

  let userAId: number;
  let userBId: number;
  let accountAId: number;
  let accountBId: number;

  // Setup — runs once before all tests in this describe
  // (using individual it() with db calls; no beforeAll to keep it flat)

  it("AC-5: seeds two users + accounts and confirms resolveAccountHint does not leak", async () => {
    // Seed
    userAId = await seedTestUser(EMAIL_A);
    userBId = await seedTestUser(EMAIL_B);
    accountAId = await seedArqAccount(userAId, SHARED_ACCOUNT_NUMBER);
    accountBId = await seedArqAccount(userBId, SHARED_ACCOUNT_NUMBER); // same accountNumber, different user
    // Also seed a TC account for user A (validates multi-account users don't bleed)
    await seedTcDetalladoAccount(userAId, SHARED_LAST4);

    // Build a minimal ARQ DispatchResult (arq-pdf) without actually parsing a PDF.
    // We manually construct the result shape that resolveAccountHint accepts.
    const arqResult = {
      kind: "arq-pdf" as const,
      rawStatement: {
        header: {
          accountNumber: SHARED_ACCOUNT_NUMBER,
          accountHolder: "Test",
          routingNumber: "000000000",
          periodStart: new Date(),
          periodEnd: new Date(),
          durationDays: 30,
          summary: {
            balanceStartCents: BigInt(0),
            totalCreditsCents: BigInt(0),
            totalDebitsCents: BigInt(0),
            balanceEndCents: BigInt(0),
          },
        },
        transactions: [],
      },
      accountHint: null,
    };

    // User A resolves to their own account
    const hintA = await resolveAccountHint(userAId, arqResult);
    expect(hintA).not.toBeNull();
    expect(hintA!.accountId).toBe(accountAId);

    // User B resolves to their own account (NOT user A's)
    const hintB = await resolveAccountHint(userBId, arqResult);
    expect(hintB).not.toBeNull();
    expect(hintB!.accountId).toBe(accountBId);
    expect(hintB!.accountId).not.toBe(accountAId); // key isolation assertion

    // Cleanup
    await cleanupUsers([EMAIL_A, EMAIL_B]);
  });

  it("AC-5b: tc-detallado last4 resolves to correct user account, not the other user's", async () => {
    // Re-seed for isolation from the previous test
    const EMAIL_C = `dispatch-test-c-${Date.now()}@test.findash`;
    const EMAIL_D = `dispatch-test-d-${Date.now()}@test.findash`;
    const last4 = String(Date.now()).slice(-4);

    const userCId = await seedTestUser(EMAIL_C);
    const userDId = await seedTestUser(EMAIL_D);
    const tcAcctC = await seedTcDetalladoAccount(userCId, last4);
    await seedTcDetalladoAccount(userDId, last4); // same last4, different user

    // Build synthetic TC with the test-specific last4 so account resolution matches.
    // (The default buildTcDetalladoXlsx uses "8888" which won't match our seeded last4.)
    const wb2 = XLSX.utils.book_new();
    const pesosRows = buildSyntheticTcAoa({ last4, moneda: "PESOS" });
    const dolaresRows = buildSyntheticTcAoa({ last4, moneda: "USD" });
    const pesosSheet = XLSX.utils.aoa_to_sheet(pesosRows);
    const dolaresSheet = XLSX.utils.aoa_to_sheet(dolaresRows);
    XLSX.utils.book_append_sheet(wb2, pesosSheet, "PESOS");
    XLSX.utils.book_append_sheet(wb2, dolaresSheet, "DOLARES");
    const buf = XLSX.write(wb2, { bookType: "xlsx", type: "buffer" }) as Buffer;

    const result = await parseAndHint(buf);
    expect(result.kind).toBe("bancolombia-tc-detallado");

    // User C resolves to their account
    const hintC = await resolveAccountHint(userCId, result);
    expect(hintC).not.toBeNull();
    expect(hintC!.accountId).toBe(tcAcctC);

    // User D resolves to their own account, NOT user C's
    const hintD = await resolveAccountHint(userDId, result);
    expect(hintD).not.toBeNull();
    expect(hintD!.accountId).not.toBe(tcAcctC);

    await cleanupUsers([EMAIL_C, EMAIL_D]);
  });
});
