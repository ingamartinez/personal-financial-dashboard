import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";

import { db } from "@/lib/db";
import { accounts, physicalCards, statementImports, transactions, users } from "@/lib/db/schema";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

import type { ConsolidationReport } from "@/lib/ingestion/bancolombia-statement/consolidate";
import { isMultiReport, type ConsolidateActionResult } from "./consolidate-types";

const TAG = "CONSOL_ACT_TEST";

// Narrowing helper — existing tests exercise the single-sheet path, so callers
// want a plain ConsolidationReport and assert on legacy fields. Fails loudly if
// the action unexpectedly returns the multi shape so we don't silently miss a
// regression.
function asSingle(result: ConsolidateActionResult): ConsolidationReport {
  if (isMultiReport(result)) {
    throw new Error(
      `asSingle: expected single-report result, got multi with ${result.reports.length} sheets`,
    );
  }
  return result;
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sessionMock = { id: 0, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

const { previewStatementAction, commitStatementAction } = await import("./actions");

function buildSyntheticXlsxBuffer(last4: string): Buffer {
  const aoa: (string | number | null)[][] = [
    ["Información Cliente:"],
    ["Cliente", null, "Dirección"],
    ["TEST", null, "CALLE 1"],
    [],
    ["Información de la Tarjeta", `************${last4}`],
    ["Moneda: ", "PESOS"],
    [],
    ["Periodo facturado: ", "01 mar", "30 mar. 2026"],
    ["Pagar antes de: ", "abr. 16, 2026"],
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
    ["Compra un mes", "0.0000 %", "0.0000 %", "+ Saldo anterior", "0,00"],
    ["Compra 2 - 36 meses", "1.9110 %", "25.5026 %", "+ Compras del mes", "500.000,00"],
    ["Impuestos", "1.9110 %", "25.5026 %", "+ Intereses de mora", "0,00"],
    ["Avances", "1.9110 %", "25.5026 %", "+ Intereses corrientes", "0,00"],
    ["Mora", "1.9110 %", "25.5026 %", "+ Avances", "0,00"],
    [null, null, null, "+ Otros cargos", "0,00"],
    [null, null, null, "Cargos", "500.000,00"],
    [null, null, null, "(-) Pagos / abonos", "0,00"],
    [null, null, null, "(-) Saldo a favor", "0,00"],
    [null, null, null, "Abono", "0,00"],
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
    [
      "010001",
      "20/03/2026",
      "TEST MERCHANT A",
      "300.000,00",
      "1/1",
      "300.000,00",
      "0,0000",
      "00,0000",
      "0,00",
    ],
    [
      "010002",
      "21/03/2026",
      "TEST MERCHANT B",
      "200.000,00",
      "1/1",
      "200.000,00",
      "0,0000",
      "00,0000",
      "0,00",
    ],
  ];
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, sheet, "PESOS");
  return Buffer.from(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
}

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createTc(
  userId: number,
  last4: string,
  institutionSlug: "bancolombia" | "nequi" = "bancolombia",
  type: "credit_card" | "savings" = "credit_card",
): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} visa ${last4}`,
      institution: "Bancolombia",
      institutionSlug,
      type,
      currency: "COP",
      metadata: { last4s: [last4], cutoffDay: 30 },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(statementImports).where(eq(statementImports.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function formDataFor(
  buffer: Buffer,
  accountId: number,
  cycle: string,
  filename = "extracto.xlsx",
): FormData {
  const fd = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fd.set("file", blob, filename);
  fd.set("accountId", String(accountId));
  fd.set("cycle", cycle);
  return fd;
}

describe("previewStatementAction / commitStatementAction", () => {
  let userId!: number;
  let tcId!: number;
  let savingsId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    sessionMock.id = userId;
    tcId = await createTc(userId, "2575");
    savingsId = await createTc(userId, "0000", "nequi", "savings");
  });

  afterEach(async () => {
    await db.execute(
      sql`DELETE FROM transactions WHERE user_id = ${userId} AND external_id LIKE 'bancolombia-stmt:%'`,
    );
    await db.execute(
      sql`DELETE FROM transactions WHERE user_id = ${userId} AND source = 'balance_adjustment'`,
    );
    await db.delete(statementImports).where(eq(statementImports.userId, userId));
    await db.execute(
      sql`DELETE FROM transactions WHERE user_id = ${userId} AND category_slug = 'intereses-tc'`,
    );
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("rejects when no file is attached", async () => {
    const fd = new FormData();
    fd.set("accountId", String(tcId));
    fd.set("cycle", "2026-03");
    await expect(previewStatementAction(fd)).rejects.toThrow(/no_file/);
  });

  it("rejects non-xlsx filenames", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    await expect(
      previewStatementAction(formDataFor(buf, tcId, "2026-03", "extract.pdf")),
    ).rejects.toThrow(/unsupported_file_type/);
  });

  it("rejects cycles that aren't YYYY-MM", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    await expect(previewStatementAction(formDataFor(buf, tcId, "oops"))).rejects.toThrow();
  });

  it("rejects when the account isn't a credit card", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    await expect(previewStatementAction(formDataFor(buf, savingsId, "2026-03"))).rejects.toThrow(
      /account_not_credit_card|unsupported_institution/,
    );
  });

  it("rejects when xlsx card last4 doesn't match the account", async () => {
    const buf = buildSyntheticXlsxBuffer("1111"); // account is 2575
    await expect(previewStatementAction(formDataFor(buf, tcId, "2026-03"))).rejects.toThrow(
      /last4_mismatch/,
    );
  });

  it("preview returns a dry-run report without writing to the DB", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    const report = asSingle(await previewStatementAction(formDataFor(buf, tcId, "2026-03")));
    expect(report.dryRun).toBe(true);
    expect(report.status).toBe("dry-run");
    // 2 missing during-period rows in the synthetic fixture (no matching txs seeded).
    expect(report.matchStats.insertedMissing).toBe(2);
    expect(report.statementImportId).toBeNull();

    const imports = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(imports).toHaveLength(0);
  });

  it("commit persists + revalidates + second call is idempotent", async () => {
    const nextCache = await import("next/cache");
    const revalidate = vi.mocked(nextCache.revalidatePath);
    revalidate.mockClear();

    const buf = buildSyntheticXlsxBuffer("2575");
    const report = asSingle(await commitStatementAction(formDataFor(buf, tcId, "2026-03")));
    expect(report.status).toBe("consolidated");
    expect(report.insertedTxIds.length).toBe(2);
    expect(report.statementImportId).not.toBeNull();
    expect(revalidate).toHaveBeenCalledWith(expect.stringContaining("/settings/accounts/"));
    expect(revalidate).toHaveBeenCalledWith("/transactions");

    const imports = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(imports).toHaveLength(1);
    expect(imports[0].kind).toBe("extracto_detallado");

    // Second call: already-consolidated, no new imports.
    const second = asSingle(await commitStatementAction(formDataFor(buf, tcId, "2026-03")));
    expect(second.status).toBe("already-consolidated");
    const stillOne = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(stillOne).toHaveLength(1);
  });

  // #432 — preview delta + breakdown
  it("dry-run projection reflects pre-commit saldo and compras insertables", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    const report = asSingle(await previewStatementAction(formDataFor(buf, tcId, "2026-03")));
    expect(report.projection).toBeDefined();
    const p = report.projection!;
    // No seeded txs → saldo actual 0.
    expect(p.saldoActualCentsStr).toBe("0");
    // 2 compras (300k + 200k) → ledger-signed total = -500.000,00 COP cents.
    expect(p.breakdown.comprasNuevasCentsStr).toBe("-50000000");
    // Dry-run: intereses are null (not yet calculated).
    expect(p.breakdown.interesesCentsStr).toBeNull();
    expect(p.breakdown.plugsObsoletosCentsStr).toBe("0");
    // delta equals compras in dry-run (no intereses).
    expect(p.deltaCentsStr).toBe("-50000000");
    expect(p.saldoProyectadoCentsStr).toBe("-50000000");
    // Floor is 500k COP = 50_000_000 cents → |delta|=50M is NOT strictly greater.
    // Verify the threshold is at least the floor.
    expect(BigInt(p.warn.thresholdCentsStr)).toBeGreaterThanOrEqual(BigInt(50_000_000));
  });

  // #433 — saldo real + plug compensador
  it("commit without saldo real input behaves identically (no plug inserted)", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    const report = asSingle(await commitStatementAction(formDataFor(buf, tcId, "2026-03")));
    expect(report.balanceAdjustment).toBeNull();
    expect(report.projection?.breakdown.balanceAdjustmentPlugCentsStr).toBeNull();

    // Ledger SUM == compras (-500k); intereses was skipped for the 1-cuota
    // fixture so no synthetic tx was added.
    const [bal] = await db
      .select({ cents: derivedBalanceCentsSql })
      .from(accounts)
      .where(eq(accounts.id, tcId));
    expect(BigInt(bal.cents)).toBe(BigInt(-50_000_000));
  });

  it("commit with saldo real matching the projected amount inserts NO plug", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    const fd = formDataFor(buf, tcId, "2026-03");
    fd.set(`saldoRealLedgerCents_${tcId}`, "-50000000");
    const report = asSingle(await commitStatementAction(fd));
    expect(report.balanceAdjustment).toBeNull();
    expect(report.projection?.breakdown.balanceAdjustmentPlugCentsStr).toBeNull();
  });

  it("commit with saldo real differing from projected inserts a compensator plug", async () => {
    const buf = buildSyntheticXlsxBuffer("2575");
    const fd = formDataFor(buf, tcId, "2026-03");
    // User claims real saldo is -600k (vs projected -500k) → plug = -100k.
    fd.set(`saldoRealLedgerCents_${tcId}`, "-60000000");
    const report = asSingle(await commitStatementAction(fd));
    expect(report.balanceAdjustment).not.toBeNull();
    expect(report.balanceAdjustment!.amountCentsStr).toBe("-10000000");
    expect(report.balanceAdjustment!.userInputCentsStr).toBe("-60000000");
    expect(report.projection?.breakdown.balanceAdjustmentPlugCentsStr).toBe("-10000000");

    // Ledger SUM post-plug MUST equal the user's input exactly.
    const [bal] = await db
      .select({ cents: derivedBalanceCentsSql })
      .from(accounts)
      .where(eq(accounts.id, tcId));
    expect(BigInt(bal.cents)).toBe(BigInt(-60_000_000));

    // The plug tx is a live balance_adjustment row linked to the import.
    const plugs = await db
      .select({
        id: transactions.id,
        amountCents: transactions.amountCents,
        source: transactions.source,
        categorySlug: transactions.categorySlug,
        statementImportId: transactions.statementImportId,
        isAdjustment: transactions.isAdjustment,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, tcId),
          eq(transactions.source, "balance_adjustment"),
        ),
      );
    expect(plugs).toHaveLength(1);
    expect(plugs[0].amountCents).toBe(BigInt(-10_000_000));
    expect(plugs[0].categorySlug).toBe("adjustments");
    expect(plugs[0].isAdjustment).toBe(true);
    expect(plugs[0].statementImportId).toBe(report.statementImportId);
  });
});

// -----------------------------------------------------------------------------
// Multi-sheet dispatch (#426): Mastercard internacional .xlsx con PESOS+DOLARES
// en un solo upload debe consolidar ambas cuentas linkeadas por physicalCardId.
// -----------------------------------------------------------------------------

function buildMultiSheetXlsxBuffer(last4: string): Buffer {
  const aoa = (moneda: "PESOS" | "DOLARES"): (string | number | null)[][] => {
    const isUsd = moneda === "DOLARES";
    const rateRows: (string | number | null)[][] = isUsd
      ? [
          ["Compra Internacional", "1.9110 %", "25.5026 %", "+ Saldo anterior", "0,00"],
          ["Avance Internacional", "1.9110 %", "25.5026 %", "+ Compras del mes", "500,00"],
          ["Mora", "1.9110 %", "25.5026 %", "+ Intereses de mora", "0,00"],
          [null, null, null, "+ Intereses corrientes", "0,00"],
          [null, null, null, "+ Avances", "0,00"],
        ]
      : [
          ["Compra un mes", "0.0000 %", "0.0000 %", "+ Saldo anterior", "0,00"],
          ["Compra 2 - 36 meses", "1.9110 %", "25.5026 %", "+ Compras del mes", "500.000,00"],
          ["Impuestos", "1.9110 %", "25.5026 %", "+ Intereses de mora", "0,00"],
          ["Avances", "1.9110 %", "25.5026 %", "+ Intereses corrientes", "0,00"],
          ["Mora", "1.9110 %", "25.5026 %", "+ Avances", "0,00"],
        ];
    const rows = isUsd
      ? [
          [
            "010003",
            "20/03/2026",
            "USD MERCHANT",
            "500,00",
            "1/1",
            "500,00",
            "0,0000",
            "00,0000",
            "0,00",
          ],
        ]
      : [
          [
            "010001",
            "20/03/2026",
            "COP MERCHANT",
            "500.000,00",
            "1/1",
            "500.000,00",
            "0,0000",
            "00,0000",
            "0,00",
          ],
        ];
    return [
      ["Información Cliente:"],
      ["Cliente", null, "Dirección"],
      ["TEST", null, "CALLE 1"],
      [],
      ["Información de la Tarjeta", `************${last4}`],
      ["Moneda: ", moneda],
      [],
      ["Periodo facturado: ", "01 mar", "30 mar. 2026"],
      ["Pagar antes de: ", "abr. 16, 2026"],
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
      [null, null, null, "Cargos", "500.000,00"],
      [null, null, null, "(-) Pagos / abonos", "0,00"],
      [null, null, null, "(-) Saldo a favor", "0,00"],
      [null, null, null, "Abono", "0,00"],
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
      ...rows,
    ];
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa("PESOS")), "PESOS");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa("DOLARES")), "DOLARES");
  return Buffer.from(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
}

async function createPhysicalCard(userId: number, last4: string): Promise<string> {
  const [row] = await db
    .insert(physicalCards)
    .values({
      id: sql`gen_random_uuid()`,
      userId,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      name: `${TAG} mastercard ${last4}`,
      creditLimitCents: BigInt(10_000_000_00),
      network: "mastercard",
      last4,
    })
    .returning({ id: physicalCards.id });
  return row.id;
}

async function createTcLinked(
  userId: number,
  last4: string,
  currency: "COP" | "USD",
  physicalCardId: string,
): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} mc ${last4} ${currency}`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "credit_card",
      currency,
      metadata: { last4s: [last4] },
      physicalCardId,
    })
    .returning({ id: accounts.id });
  return row.id;
}

describe("multi-sheet dispatch (#426)", () => {
  let userId!: number;
  let pcId!: string;
  let copAccountId!: number;
  let usdAccountId!: number;
  let soloCopAccountId!: number; // no sibling → should reject multi-sheet

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.ms.${Date.now()}@test.local`);
    sessionMock.id = userId;
    pcId = await createPhysicalCard(userId, "7291");
    copAccountId = await createTcLinked(userId, "7291", "COP", pcId);
    usdAccountId = await createTcLinked(userId, "7291", "USD", pcId);
    const soloPc = await createPhysicalCard(userId, "5555");
    soloCopAccountId = await createTcLinked(userId, "5555", "COP", soloPc);
  });

  afterEach(async () => {
    await db.execute(
      sql`DELETE FROM transactions WHERE user_id = ${userId} AND external_id LIKE 'bancolombia-stmt:%'`,
    );
    await db.execute(
      sql`DELETE FROM transactions WHERE user_id = ${userId} AND source = 'balance_adjustment'`,
    );
    await db.delete(statementImports).where(eq(statementImports.userId, userId));
    await db.execute(
      sql`DELETE FROM transactions WHERE user_id = ${userId} AND category_slug = 'intereses-tc'`,
    );
  });

  afterAll(async () => {
    await db.delete(accounts).where(eq(accounts.userId, userId));
    await db.delete(physicalCards).where(eq(physicalCards.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("preview against a multi-sheet xlsx returns reports for BOTH sibling accounts", async () => {
    const buf = buildMultiSheetXlsxBuffer("7291");
    const result = await previewStatementAction(formDataFor(buf, copAccountId, "2026-03"));
    if (!isMultiReport(result)) {
      throw new Error("expected multi-sheet result");
    }
    expect(result.reports).toHaveLength(2);
    const byCurrency = Object.fromEntries(result.reports.map((r) => [r.currency, r]));
    expect(byCurrency.COP.accountId).toBe(copAccountId);
    expect(byCurrency.USD.accountId).toBe(usdAccountId);
    expect(byCurrency.COP.status).toBe("dry-run");
    expect(byCurrency.USD.status).toBe("dry-run");
    expect(byCurrency.COP.matchStats.insertedMissing).toBe(1);
    expect(byCurrency.USD.matchStats.insertedMissing).toBe(1);
    // Dry-run should not write.
    const imports = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(imports).toHaveLength(0);
  });

  it("commit against a multi-sheet xlsx writes one statement_imports row per account", async () => {
    const buf = buildMultiSheetXlsxBuffer("7291");
    const result = await commitStatementAction(formDataFor(buf, copAccountId, "2026-03"));
    if (!isMultiReport(result)) throw new Error("expected multi-sheet result");
    expect(result.reports).toHaveLength(2);
    expect(result.reports.every((r) => r.status === "consolidated")).toBe(true);

    const imports = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(imports).toHaveLength(2);
    const accountIds = new Set(imports.map((i) => i.accountId));
    expect(accountIds.has(copAccountId)).toBe(true);
    expect(accountIds.has(usdAccountId)).toBe(true);

    // Re-commit is idempotent per account (both come back already-consolidated).
    const second = await commitStatementAction(formDataFor(buf, copAccountId, "2026-03"));
    if (!isMultiReport(second)) throw new Error("expected multi-sheet result");
    expect(second.reports.every((r) => r.status === "already-consolidated")).toBe(true);
    const stillTwo = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(stillTwo).toHaveLength(2);
  });

  it("multi-sheet xlsx on an account without a USD sibling throws missing_usd_sibling", async () => {
    const buf = buildMultiSheetXlsxBuffer("5555");
    await expect(
      previewStatementAction(formDataFor(buf, soloCopAccountId, "2026-03")),
    ).rejects.toThrow(/missing_usd_sibling/);
  });

  it("entering from the USD sibling also dispatches to both accounts", async () => {
    const buf = buildMultiSheetXlsxBuffer("7291");
    const result = await previewStatementAction(formDataFor(buf, usdAccountId, "2026-03"));
    if (!isMultiReport(result)) throw new Error("expected multi-sheet result");
    expect(result.reports).toHaveLength(2);
    const byCurrency = Object.fromEntries(result.reports.map((r) => [r.currency, r]));
    expect(byCurrency.COP.accountId).toBe(copAccountId);
    expect(byCurrency.USD.accountId).toBe(usdAccountId);
  });

  // #433 — multi-sheet: user provides a saldo real per currency → one plug
  // per sub-account. Empty field on one side means no plug on that currency.
  it("multi-sheet commit inserts one plug per currency the user provided", async () => {
    const buf = buildMultiSheetXlsxBuffer("7291");
    const fd = formDataFor(buf, copAccountId, "2026-03");
    // COP side: claim -600k (projected -500k) → plug -100k.
    fd.set(`saldoRealLedgerCents_${copAccountId}`, "-60000000");
    // USD side: claim -600 USD (-60000 cents) vs projected -500 USD (-50000 cents) → plug -10000.
    fd.set(`saldoRealLedgerCents_${usdAccountId}`, "-60000");
    const result = await commitStatementAction(fd);
    if (!isMultiReport(result)) throw new Error("expected multi-sheet result");
    const byCurrency = Object.fromEntries(result.reports.map((r) => [r.currency, r]));
    expect(byCurrency.COP.balanceAdjustment).not.toBeNull();
    expect(byCurrency.COP.balanceAdjustment!.amountCentsStr).toBe("-10000000");
    expect(byCurrency.USD.balanceAdjustment).not.toBeNull();
    expect(byCurrency.USD.balanceAdjustment!.amountCentsStr).toBe("-10000");

    // Both plug txs are present in the ledger, linked to the respective imports.
    const plugs = await db
      .select({
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        statementImportId: transactions.statementImportId,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.source, "balance_adjustment")));
    expect(plugs).toHaveLength(2);
    const plugByAccount = new Map(plugs.map((p) => [p.accountId, p]));
    expect(plugByAccount.get(copAccountId)?.amountCents).toBe(BigInt(-10_000_000));
    expect(plugByAccount.get(usdAccountId)?.amountCents).toBe(BigInt(-10_000));
  });

  // #432 — multi-sheet: each report carries its own projection with the right
  // currency + delta (500k COP on PESOS, 500 USD on DOLARES, both in ledger sign).
  it("multi-sheet preview returns one projection per currency with the right delta", async () => {
    const buf = buildMultiSheetXlsxBuffer("7291");
    const result = await previewStatementAction(formDataFor(buf, copAccountId, "2026-03"));
    if (!isMultiReport(result)) throw new Error("expected multi-sheet result");
    const byCurrency = Object.fromEntries(result.reports.map((r) => [r.currency, r]));
    expect(byCurrency.COP.projection).toBeDefined();
    expect(byCurrency.USD.projection).toBeDefined();
    expect(byCurrency.COP.projection!.deltaCentsStr).toBe("-50000000");
    expect(byCurrency.COP.projection!.breakdown.comprasNuevasCentsStr).toBe("-50000000");
    // USD: 500,00 → 50000 cents, ledger-signed = -50000.
    expect(byCurrency.USD.projection!.deltaCentsStr).toBe("-50000");
    expect(byCurrency.USD.projection!.breakdown.comprasNuevasCentsStr).toBe("-50000");
    // USD threshold floor is 125 USD = 12500 cents; |delta|=50000 > 12500 → warn.
    expect(byCurrency.USD.projection!.warn.exceeded).toBe(true);
  });
});
