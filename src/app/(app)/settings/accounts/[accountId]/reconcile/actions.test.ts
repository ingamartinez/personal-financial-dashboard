// #444 — integration tests for previewReconcile + applyReconcile with the
// multi-currency Mastercard Internacional flow. Exercises:
//   - single-currency upload (no sibling) → legacy behavior
//   - currency_mismatch rejection
//   - multi_currency_without_physical_card rejection
//   - missing_usd_sibling rejection
//   - shared-plastic dispatch: preview + apply routes per-row to the
//     correct sub-account

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as XLSX from "xlsx";

import { db } from "@/lib/db";
import { accounts, physicalCards, statementImports, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

const TAG = "RECON_ACT_TEST";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sessionMock = { id: 0, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

const { previewReconcile, applyReconcile, expandReconcileWindow } = await import("./actions");

describe("expandReconcileWindow (#543)", () => {
  it("expands the period boundary by the match-engine tolerance on both sides", () => {
    // periodEnd at midnight Bogotá of 2026-04-26 = 2026-04-26T05:00:00Z
    const periodStart = new Date("2026-04-01T05:00:00Z");
    const periodEnd = new Date("2026-04-26T05:00:00Z");
    const { windowStart, windowEnd } = expandReconcileWindow(periodStart, periodEnd);
    // 3 days of slack matches DEFAULT_DATE_TOLERANCE_DAYS in match.ts
    expect(windowStart.toISOString()).toBe("2026-03-29T05:00:00.000Z");
    expect(windowEnd.toISOString()).toBe("2026-04-29T05:00:00.000Z");
  });

  it("a Gmail-captured tx at 21:33 Bogotá the same day as periodEnd falls inside the window", () => {
    // periodEnd from XLSX = midnight Bogotá of 2026-04-26
    const periodEnd = new Date("2026-04-26T05:00:00Z");
    // Gmail tx recorded at 21:33 Bogotá of 2026-04-26 (= 02:33 UTC of 2026-04-27)
    const gmailTx = new Date("2026-04-27T02:33:00Z");
    // Without the fix this assertion would have failed: gmailTx > periodEnd in UTC
    expect(gmailTx.getTime() > periodEnd.getTime()).toBe(true);
    const { windowEnd } = expandReconcileWindow(new Date("2026-04-01T05:00:00Z"), periodEnd);
    expect(gmailTx.getTime() <= windowEnd.getTime()).toBe(true);
  });
});

// Builds a Mastercard-style TC xlsx (single sheet, 6 columns: Fecha,
// Descripción, Fecha de corte, Valor, Tipo de moneda, Cuotas). When
// `rows` is provided we use it verbatim; otherwise we ship a default
// mixed COP+USD + pure-COP fixture matching the real file shape.
function buildXlsxBuffer(
  rows: Array<[number, string, number | null, number, "COP" | "USD", number]>,
): Buffer {
  const aoa: (string | number | null)[][] = [
    ["Fecha", "Descripción", "Fecha de corte", "Valor", "Tipo de moneda", "Cuotas"],
    ...rows,
  ];
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, sheet, "Hoja 1");
  return Buffer.from(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
}

function mixedFixture(): Buffer {
  return buildXlsxBuffer([
    [46127, "RAPPI COP", null, 30000, "COP", 1],
    [46127, "AMAZON PRIME", null, 14.99, "USD", 36],
    [46126, "ABONO VIRTUAL", null, -130469, "COP", 0],
  ]);
}

function copOnlyFixture(): Buffer {
  return buildXlsxBuffer([
    [46127, "RAPPI", null, 30000, "COP", 1],
    [46127, "DIDI", null, 15000, "COP", 1],
  ]);
}

function usdOnlyFixture(): Buffer {
  return buildXlsxBuffer([[46127, "USD MERCHANT", null, 10, "USD", 1]]);
}

function formDataFor(buffer: Buffer, accountId: number, filename = "mov.xlsx"): FormData {
  const fd = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fd.set("file", blob, filename);
  fd.set("accountId", String(accountId));
  return fd;
}

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createPhysicalCard(userId: number, last4: string): Promise<string> {
  const [row] = await db
    .insert(physicalCards)
    .values({
      id: sql`gen_random_uuid()`,
      userId,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      name: `${TAG} mc ${last4}`,
      creditLimitCents: BigInt(10_000_000_00),
      network: "mastercard",
      last4,
    })
    .returning({ id: physicalCards.id });
  return row.id;
}

async function createLinkedTc(
  userId: number,
  currency: "COP" | "USD",
  physicalCardId: string,
  last4: string,
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
      physicalCardId,
      metadata: { last4s: [last4] },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createSoloTc(
  userId: number,
  currency: "COP" | "USD",
  last4: string,
): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} solo ${last4}`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "credit_card",
      currency,
      metadata: { last4s: [last4] },
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function cleanupUser(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(statementImports).where(eq(statementImports.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(physicalCards).where(eq(physicalCards.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe("previewReconcile + applyReconcile — multi-currency (#444)", () => {
  let userId!: number;
  let pcId!: string;
  let copAccountId!: number;
  let usdAccountId!: number;
  let soloCopAccountId!: number;
  let soloCopWithPcId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    sessionMock.id = userId;
    pcId = await createPhysicalCard(userId, "7291");
    copAccountId = await createLinkedTc(userId, "COP", pcId, "7291");
    usdAccountId = await createLinkedTc(userId, "USD", pcId, "7291");
    soloCopAccountId = await createSoloTc(userId, "COP", "2575");
    // A COP account with a physical_card but NO sibling → used to validate
    // `missing_usd_sibling` dispatches the correct error.
    const soloPc = await createPhysicalCard(userId, "5555");
    soloCopWithPcId = await createLinkedTc(userId, "COP", soloPc, "5555");
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("single-currency upload returns multiCurrency=null and preserves legacy shape", async () => {
    const buf = copOnlyFixture();
    const preview = await previewReconcile(formDataFor(buf, soloCopAccountId));
    expect(preview.multiCurrency).toBeNull();
    expect(preview.accountId).toBe(soloCopAccountId);
    expect(preview.parsed.rows).toHaveLength(2);
  });

  it("rejects currency_mismatch when a USD-only file is uploaded to a COP account", async () => {
    const buf = usdOnlyFixture();
    await expect(previewReconcile(formDataFor(buf, soloCopAccountId))).rejects.toThrow(
      /currency_mismatch/,
    );
  });

  it("rejects multi_currency_without_physical_card when the origin has no plastic link", async () => {
    const buf = mixedFixture();
    await expect(previewReconcile(formDataFor(buf, soloCopAccountId))).rejects.toThrow(
      /multi_currency_without_physical_card/,
    );
  });

  it("rejects missing_usd_sibling when the plastic has no USD sibling linked", async () => {
    const buf = mixedFixture();
    await expect(previewReconcile(formDataFor(buf, soloCopWithPcId))).rejects.toThrow(
      /missing_usd_sibling/,
    );
  });

  it("preview resolves plastic-linked siblings and counts rows per currency", async () => {
    const buf = mixedFixture();
    const preview = await previewReconcile(formDataFor(buf, copAccountId));
    expect(preview.multiCurrency).not.toBeNull();
    expect(preview.multiCurrency!.siblingAccountId).toBe(usdAccountId);
    expect(preview.multiCurrency!.siblingCurrency).toBe("USD");
    expect(preview.multiCurrency!.originCurrency).toBe("COP");
    expect(preview.multiCurrency!.rowsByCurrency.COP).toBe(2); // RAPPI + ABONO
    expect(preview.multiCurrency!.rowsByCurrency.USD).toBe(1); // AMAZON PRIME
  });

  it("preview entered from the USD sibling dispatches the same way", async () => {
    const buf = mixedFixture();
    const preview = await previewReconcile(formDataFor(buf, usdAccountId));
    expect(preview.multiCurrency).not.toBeNull();
    expect(preview.accountId).toBe(usdAccountId);
    expect(preview.multiCurrency!.siblingAccountId).toBe(copAccountId);
    expect(preview.multiCurrency!.originCurrency).toBe("USD");
    expect(preview.multiCurrency!.siblingCurrency).toBe("COP");
  });

  it("apply writes txs to the correct sub-account by parsedRow.currency", async () => {
    const buf = mixedFixture();
    const preview = await previewReconcile(formDataFor(buf, copAccountId));
    const result = await applyReconcile({
      accountId: copAccountId,
      fileHash: preview.fileHash,
      parsed: preview.parsed,
      plan: preview.plan,
      userBalanceAtEndCents: null,
    });
    expect(result.status).toBe("applied");
    expect(result.inserted).toBe(3);

    const copTxs = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, copAccountId),
          eq(transactions.source, "csv_reconcile"),
        ),
      );
    const usdTxs = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, usdAccountId),
          eq(transactions.source, "csv_reconcile"),
        ),
      );
    expect(copTxs).toHaveLength(2);
    expect(usdTxs).toHaveLength(1);
    expect(copTxs.every((t) => t.currency === "COP")).toBe(true);
    // The amazon prime row must persist as USD -14.99 on the USD sibling —
    // this is the exact scenario that produced 25 mis-currency txs in prod
    // before the fix.
    expect(usdTxs[0].currency).toBe("USD");
    expect(usdTxs[0].amountCents).toBe(BigInt(-14_99));

    // Two statement_imports rows (one per sub-account, both with the same
    // fileHash for idempotent re-apply per-side).
    const imports = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    const byAccount = new Map(imports.map((i) => [i.accountId, i]));
    expect(byAccount.get(copAccountId)?.fileHash).toBe(preview.fileHash);
    expect(byAccount.get(usdAccountId)?.fileHash).toBe(preview.fileHash);

    // Re-apply = already_imported (no new rows).
    const second = await applyReconcile({
      accountId: copAccountId,
      fileHash: preview.fileHash,
      parsed: preview.parsed,
      plan: preview.plan,
      userBalanceAtEndCents: null,
    });
    expect(second.status).toBe("already_imported");
  });
});
