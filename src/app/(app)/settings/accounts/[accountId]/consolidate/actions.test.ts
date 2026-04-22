import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";

import { db } from "@/lib/db";
import { accounts, statementImports, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

const TAG = "CONSOL_ACT_TEST";

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
    const report = await previewStatementAction(formDataFor(buf, tcId, "2026-03"));
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
    const report = await commitStatementAction(formDataFor(buf, tcId, "2026-03"));
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
    const second = await commitStatementAction(formDataFor(buf, tcId, "2026-03"));
    expect(second.status).toBe("already-consolidated");
    const stillOne = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(stillOne).toHaveLength(1);
  });
});
