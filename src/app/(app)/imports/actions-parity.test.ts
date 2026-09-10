// #905 — parity of the unified Bancolombia-savings path against applyReconcile:
//   - userBalanceAtEndCents persists onto statement_imports.balance_at_end_cents
//     (null when omitted; ignored conceptually in multi-currency via the
//     shared resolveReconcileDispatch throws)
//   - currency_mismatch / missing-sibling throws instead of proceeding
//
// Hits findash_test via vitest.setup.ts. parseAndHint is mocked so we don't
// need a real XLSX; commitReconciliation is real.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, physicalCards, statementImports, transactions, users } from "@/lib/db/schema";
import type { ParsedStatement } from "@/lib/reconciliation/parsers/types";

const TAG = "IMPORTS_PARITY_905";

const { mockGetSessionUser, mockParseAndHint, mockResolveAccountHint } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
  mockParseAndHint: vi.fn(),
  mockResolveAccountHint: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: mockGetSessionUser }));
vi.mock("@/lib/ingestion/dispatch", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ingestion/dispatch")>();
  return {
    ...original,
    parseAndHint: mockParseAndHint,
    resolveAccountHint: mockResolveAccountHint,
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/classification/enqueue", () => ({
  classifyByRuleThenEnqueue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/reconciliation/pago-tc-router", () => ({
  applyPagoTcRouting: vi.fn().mockResolvedValue({
    detected: 0,
    noOpPesos: 0,
    reassignedToUsd: 0,
    pendingUsdReassignment: 0,
    newPairsInserted: 0,
    errors: [],
  }),
}));
vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 1 }),
}));

const { previewIngestion, commitIngestion } = await import("./actions");
const { emitNotification } = await import("@/lib/notifications/emit");

let userId: number;
let copAccountId: number;
let soloCopWithPcId: number;

async function cleanup() {
  await db
    .delete(transactions)
    .where(sql`${transactions.userId} IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`);
  await db
    .delete(statementImports)
    .where(sql`${statementImports.userId} IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`);
  await db
    .delete(accounts)
    .where(sql`${accounts.userId} IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`);
  await db
    .delete(physicalCards)
    .where(sql`${physicalCards.userId} IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`);
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

function session() {
  return {
    id: userId,
    email: `${TAG}@test.local`,
    name: TAG,
    role: "user" as const,
    active: true,
  };
}

function makeParsed(currency: "COP" | "USD"): ParsedStatement {
  const occurredAt = new Date("2026-04-15T05:00:00Z");
  return {
    bank: "bancolombia",
    format: "bancolombia_savings",
    periodStart: new Date("2026-04-01T05:00:00Z"),
    periodEnd: new Date("2026-04-30T05:00:00Z"),
    rowCount: 1,
    balanceAtEndCents: null,
    rows: [
      {
        occurredAt,
        amountCents: BigInt(1_000_00),
        currency,
        direction: "in",
        descriptionRaw: `${TAG} row`,
        rawData: {},
        isMetadata: false,
      },
    ],
  };
}

function makeDispatch(currency: "COP" | "USD") {
  return {
    kind: "bancolombia-savings" as const,
    parsed: makeParsed(currency),
    accountHint: null,
  };
}

function makeMixedDispatch() {
  const occurredAt = new Date("2026-04-15T05:00:00Z");
  const row = (
    currency: "COP" | "USD",
    amountCents: bigint,
    descriptionRaw: string,
  ): ParsedStatement["rows"][number] => ({
    occurredAt,
    amountCents,
    currency,
    direction: "out",
    descriptionRaw,
    rawData: {},
    isMetadata: false,
  });
  return {
    kind: "bancolombia-savings" as const,
    parsed: {
      bank: "bancolombia" as const,
      format: "bancolombia_savings" as const,
      periodStart: new Date("2026-04-01T05:00:00Z"),
      periodEnd: new Date("2026-04-30T05:00:00Z"),
      rowCount: 2,
      balanceAtEndCents: null,
      rows: [row("COP", BigInt(30_000_00), `${TAG} cop`), row("USD", BigInt(14_99), `${TAG} usd`)],
    },
    accountHint: null,
  };
}

function makeFormData(tag: string, extra?: Record<string, string>): FormData {
  const formData = new FormData();
  const bytes = new Uint8Array(16);
  bytes[0] = 0x50; // P
  bytes[1] = 0x4b; // K
  bytes[2] = 0x03;
  bytes[3] = 0x04;
  // Unique payload so fileHash differs across commits.
  const encoded = new TextEncoder().encode(tag);
  bytes.set(encoded.subarray(0, Math.min(encoded.length, 12)), 4);
  formData.append(
    "file",
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${tag}.xlsx`,
  );
  if (extra) {
    for (const [k, v] of Object.entries(extra)) formData.append(k, v);
  }
  return formData;
}

beforeAll(async () => {
  await cleanup();
  const [user] = await db
    .insert(users)
    .values({ email: `${TAG}@test.local`, name: TAG })
    .returning({ id: users.id });
  userId = user.id;
  const [account] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}-savings`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      currency: "COP",
      type: "savings",
    })
    .returning({ id: accounts.id });
  copAccountId = account.id;

  const [pc] = await db
    .insert(physicalCards)
    .values({
      id: sql`gen_random_uuid()`,
      userId,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      name: `${TAG} solo pc`,
      creditLimitCents: BigInt(10_000_000_00),
      network: "mastercard",
      last4: "5555",
    })
    .returning({ id: physicalCards.id });
  const [soloWithPc] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} solo-pc`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      currency: "COP",
      type: "credit_card",
      physicalCardId: pc.id,
      metadata: { last4s: ["5555"] },
    })
    .returning({ id: accounts.id });
  soloCopWithPcId = soloWithPc.id;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockParseAndHint.mockReset();
  mockResolveAccountHint.mockReset();
  mockGetSessionUser.mockResolvedValue(session());
  mockResolveAccountHint.mockResolvedValue(null);
  vi.mocked(emitNotification).mockReset();
  vi.mocked(emitNotification).mockResolvedValue({ id: 1 });
});

describe("commitIngestion — userBalanceAtEndCents (#905)", () => {
  it("persists userBalanceAtEndCents on statement_imports when provided", async () => {
    mockParseAndHint.mockResolvedValue(makeDispatch("COP"));
    const preview = await previewIngestion(
      makeFormData("with-balance", { hint_account_id: String(copAccountId) }),
    );
    expect(preview.kind).toBe("bancolombia-savings");
    if (preview.kind === "format_unknown") throw new Error("unexpected kind");
    expect(preview.token).toBeTruthy();

    const result = await commitIngestion(preview.token, {
      userBalanceAtEndCents: "1234567800",
    });
    expect(result.status).toBe("committed");

    const [imp] = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    expect(imp.balanceAtEndCents).toBe(BigInt(12_345_678_00));
    expect(imp.accountId).toBe(copAccountId);
  });

  it("stores null balance_at_end_cents when userBalanceAtEndCents is omitted", async () => {
    mockParseAndHint.mockResolvedValue(makeDispatch("COP"));
    const preview = await previewIngestion(
      makeFormData("no-balance", { hint_account_id: String(copAccountId) }),
    );
    if (preview.kind === "format_unknown") throw new Error("unexpected kind");

    const result = await commitIngestion(preview.token);
    expect(result.status).toBe("committed");

    const rows = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.userId, userId));
    const without = rows.find((r) => r.balanceAtEndCents === null);
    expect(without).toBeDefined();
    expect(without!.accountId).toBe(copAccountId);
  });
});

describe("previewIngestion — #444 dispatch throws (#905)", () => {
  it("rejects currency_mismatch when a USD-only file is previewed against a COP account", async () => {
    mockParseAndHint.mockResolvedValue(makeDispatch("USD"));
    await expect(
      previewIngestion(makeFormData("usd-on-cop", { hint_account_id: String(copAccountId) })),
    ).rejects.toThrow(/currency_mismatch/);
  });

  it("rejects multi_currency_without_physical_card when the origin has no plastic link", async () => {
    mockParseAndHint.mockResolvedValue(makeMixedDispatch());
    await expect(
      previewIngestion(makeFormData("mixed-no-pc", { hint_account_id: String(copAccountId) })),
    ).rejects.toThrow(/multi_currency_without_physical_card/);
  });

  it("rejects missing_usd_sibling when the plastic has no USD sibling linked", async () => {
    mockParseAndHint.mockResolvedValue(makeMixedDispatch());
    await expect(
      previewIngestion(makeFormData("mixed-no-usd", { hint_account_id: String(soloCopWithPcId) })),
    ).rejects.toThrow(/missing_usd_sibling/);
  });
});

describe("commitIngestion — notifications (#905)", () => {
  it("emits statement_import_complete once when status is applied, not flagged when flagged === 0", async () => {
    mockParseAndHint.mockResolvedValue(makeDispatch("COP"));
    const preview = await previewIngestion(
      makeFormData("emit-complete", { hint_account_id: String(copAccountId) }),
    );
    if (preview.kind === "format_unknown") throw new Error("unexpected kind");

    const result = await commitIngestion(preview.token);
    expect(result.status).toBe("committed");

    const completeCall = vi
      .mocked(emitNotification)
      .mock.calls.find(([, input]) => input.type === "statement_import_complete");
    expect(completeCall).toBeDefined();
    expect(completeCall![1]).toMatchObject({
      type: "statement_import_complete",
      priority: "medium",
    });
    const flaggedCall = vi
      .mocked(emitNotification)
      .mock.calls.find(([, input]) => input.type === "reconciliation_flagged_txns");
    expect(flaggedCall).toBeUndefined();
  });

  it("emits reconciliation_flagged_txns once when flagged > 0", async () => {
    await db.insert(transactions).values({
      userId,
      accountId: copAccountId,
      occurredAt: new Date("2026-04-15T05:00:00Z"),
      amountCents: BigInt(-50_000),
      currency: "COP",
      descriptionRaw: `${TAG} leftover`,
      source: "sms",
      channel: "bank",
    });

    mockParseAndHint.mockResolvedValue(makeDispatch("COP"));
    const preview = await previewIngestion(
      makeFormData("emit-flagged", { hint_account_id: String(copAccountId) }),
    );
    if (preview.kind === "format_unknown") throw new Error("unexpected kind");

    const result = await commitIngestion(preview.token);
    expect(result.status).toBe("committed");
    expect(result.kind === "bancolombia-savings" && result.flagged).toBeGreaterThan(0);

    const flaggedCall = vi
      .mocked(emitNotification)
      .mock.calls.find(([, input]) => input.type === "reconciliation_flagged_txns");
    expect(flaggedCall).toBeDefined();
    expect(flaggedCall![1]).toMatchObject({
      type: "reconciliation_flagged_txns",
      audience: "user",
      priority: "high",
    });
  });

  it("does NOT emit statement_import_complete when status is already_imported", async () => {
    mockParseAndHint.mockResolvedValue(makeDispatch("COP"));
    const firstPreview = await previewIngestion(
      makeFormData("dup-file", { hint_account_id: String(copAccountId) }),
    );
    if (firstPreview.kind === "format_unknown") throw new Error("unexpected kind");
    const first = await commitIngestion(firstPreview.token);
    expect(first.status).toBe("committed");

    vi.mocked(emitNotification).mockClear();

    mockParseAndHint.mockResolvedValue(makeDispatch("COP"));
    const secondPreview = await previewIngestion(
      makeFormData("dup-file", { hint_account_id: String(copAccountId) }),
    );
    if (secondPreview.kind === "format_unknown") throw new Error("unexpected kind");
    const second = await commitIngestion(secondPreview.token);
    expect(second.status).toBe("already_imported");

    const completeCall = vi
      .mocked(emitNotification)
      .mock.calls.find(([, input]) => input.type === "statement_import_complete");
    expect(completeCall).toBeUndefined();
  });
});
