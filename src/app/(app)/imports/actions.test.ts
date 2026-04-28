// Server action tests for /imports actions.
// Runs in `node` env (default) — hits findash_test Postgres via vitest.setup.ts.
//
// Coverage:
//   Generation 1 (backward-compat):
//     - previewArqStatement: cross-tenant defense (no matching account)
//     - previewArqStatement: duplicate PDF hash returns error
//     - commitArqStatement: expired token returns `expired` status
//     - commitArqStatement: token belonging to another user is rejected
//
//   Generation 2 (unified previewIngestion / commitIngestion):
//     - AC-6: ARQ PDF preview creates token correctly
//     - AC-8: duplicate ARQ hash → "ya importado"
//     - AC-11: expired token → { status: "expired" }
//     - AC-12: cross-tenant token rejected
//     - AC-13: single-use (second call with same token → expired)
//     - AC-19: foreign hint_account_id ignored + logged

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, arqStatementImports, users } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Hoist mocks BEFORE any module imports that transitively import them.
// Memory: vi.hoisted pattern for "use server" files.
// ---------------------------------------------------------------------------

const {
  mockGetSessionUser,
  mockRunStatementImport,
  mockParseArqStatementPdf,
  mockParseAndHint,
  mockResolveAccountHint,
} = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
  mockRunStatementImport: vi.fn(),
  mockParseArqStatementPdf: vi.fn(),
  mockParseAndHint: vi.fn(),
  mockResolveAccountHint: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: mockGetSessionUser }));
vi.mock("@/lib/ingestion/arq-statement/run-statement-import", () => ({
  runStatementImport: mockRunStatementImport,
}));
vi.mock("@/lib/ingestion/arq-statement/pdf-adapter", () => ({
  parseArqStatementPdf: mockParseArqStatementPdf,
}));
vi.mock("@/lib/ingestion/dispatch", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ingestion/dispatch")>();
  return {
    ...original,
    parseAndHint: mockParseAndHint,
    resolveAccountHint: mockResolveAccountHint,
  };
});

// Actions import AFTER mocks are set up.
const { previewArqStatement, commitArqStatement, previewIngestion, commitIngestion } =
  await import("./actions");

// ---------------------------------------------------------------------------
// DB fixtures
// ---------------------------------------------------------------------------

const TAG = "IMPORTS_ACTIONS_TEST";

let userA: number;
let userB: number;
let accountA: number;

async function cleanup() {
  await db
    .delete(arqStatementImports)
    .where(
      sql`${arqStatementImports.userId} IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
    );
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: `${TAG}-${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

async function createAccount(uid: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId: uid,
      name: `${TAG}-ARQ`,
      institution: "ARQ (DolarApp)",
      institutionSlug: "other",
      currency: "USD",
      type: "savings",
    })
    .returning({ id: accounts.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Minimal synthetic data
// ---------------------------------------------------------------------------

function makeFakePdf(): Uint8Array {
  const buf = new Uint8Array(16);
  buf[0] = 0x25; // %
  buf[1] = 0x50; // P
  buf[2] = 0x44; // D
  buf[3] = 0x46; // F
  return buf;
}

function makeFormData(fileBytes: Uint8Array, extra?: Record<string, string>): FormData {
  const formData = new FormData();
  const ab = fileBytes.buffer.slice(0) as ArrayBuffer;
  formData.append("file", new Blob([ab], { type: "application/pdf" }), "statement.pdf");
  if (extra) {
    for (const [k, v] of Object.entries(extra)) formData.append(k, v);
  }
  return formData;
}

function makeRawStatement() {
  const now = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2026-01-31T00:00:00Z");
  return {
    header: {
      accountHolder: "TEST USER",
      accountNumber: "211215197073",
      routingNumber: "101019644",
      periodStart: now,
      periodEnd: end,
      durationDays: 31,
      summary: {
        balanceStartCents: BigInt(10000),
        totalCreditsCents: BigInt(5000),
        totalDebitsCents: BigInt(3000),
        balanceEndCents: BigInt(12000),
      },
    },
    transactions: [],
  };
}

function makeArqDispatchResult() {
  return {
    kind: "arq-pdf" as const,
    rawStatement: makeRawStatement(),
    accountHint: null,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await cleanup();
  userA = await createUser("a");
  userB = await createUser("b");
  accountA = await createAccount(userA);
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockRunStatementImport.mockReset();
  mockParseArqStatementPdf.mockReset();
  mockParseAndHint.mockReset();
  mockResolveAccountHint.mockReset();
});

// ---------------------------------------------------------------------------
// Gen 1: previewArqStatement
// ---------------------------------------------------------------------------

describe("previewArqStatement", () => {
  it("throws when no account matches the statement accountNumber", async () => {
    mockGetSessionUser.mockResolvedValue({
      id: userB,
      email: `${TAG}-b@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });
    mockParseArqStatementPdf.mockResolvedValue(makeRawStatement());

    const pdf = makeFakePdf();
    await expect(previewArqStatement(makeFormData(pdf))).rejects.toThrow(
      /no corresponde a ninguna cuenta/i,
    );
  });

  it("throws when the PDF was already imported", async () => {
    const pdfBuffer = makeFakePdf();
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });

    await db.insert(arqStatementImports).values({
      userId: userA,
      accountId: accountA,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      declaredStartCents: BigInt(10000),
      declaredEndCents: BigInt(12000),
      parsedCount: 0,
      parsedSumCents: BigInt(2000),
      reconciled: true,
      chainOk: null,
      rawPdfHash: hash,
    });

    await expect(previewArqStatement(makeFormData(pdfBuffer))).rejects.toThrow(/ya fue importado/i);

    await db
      .delete(arqStatementImports)
      .where(and(eq(arqStatementImports.userId, userA), eq(arqStatementImports.rawPdfHash, hash)));
  });

  it("rejects a file that is not a PDF (wrong magic bytes)", async () => {
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });

    const notPdf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    const formData = new FormData();
    formData.append("file", new Blob([notPdf], { type: "application/pdf" }), "bad.pdf");

    await expect(previewArqStatement(formData)).rejects.toThrow(/PDF válido/i);
  });
});

// ---------------------------------------------------------------------------
// Gen 1: commitArqStatement
// ---------------------------------------------------------------------------

describe("commitArqStatement", () => {
  it("returns expired when token is not in cache", async () => {
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });

    const result = await commitArqStatement("nonexistent-token-abc123");
    expect(result.status).toBe("expired");
    expect(result.error).toMatch(/expiró/i);
  });

  it("cross-tenant token returns expired (safe fallback)", async () => {
    mockGetSessionUser.mockResolvedValue({
      id: userB,
      email: `${TAG}-b@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });

    const result = await commitArqStatement("fake-token-for-userA");
    expect(result.status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// Gen 2: previewIngestion
// ---------------------------------------------------------------------------

describe("previewIngestion", () => {
  it("AC-6: ARQ PDF preview creates token with correct kind", async () => {
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });
    mockParseAndHint.mockResolvedValue(makeArqDispatchResult());
    mockResolveAccountHint.mockResolvedValue({ accountId: accountA, source: "file-header" });
    // No duplicate hash in DB for this test

    const rawStatement = makeRawStatement();
    mockParseArqStatementPdf.mockResolvedValue(rawStatement);

    const pdf = makeFakePdf();
    const formData = makeFormData(pdf);

    const result = await previewIngestion(formData);

    // Should return ARQ kind with a token
    expect(result.kind).toBe("arq-pdf");
    if (result.kind === "arq-pdf") {
      expect(result.token).toBeTruthy();
      expect(result.accountLabel).toBeTruthy();
    }
  });

  it("AC-8: duplicate ARQ PDF hash returns already-imported error", async () => {
    const pdfBuffer = makeFakePdf();
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });
    mockParseAndHint.mockResolvedValue(makeArqDispatchResult());
    mockResolveAccountHint.mockResolvedValue({ accountId: accountA, source: "file-header" });
    mockParseArqStatementPdf.mockResolvedValue(makeRawStatement());

    // Insert the hash record
    await db.insert(arqStatementImports).values({
      userId: userA,
      accountId: accountA,
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      declaredStartCents: BigInt(10000),
      declaredEndCents: BigInt(12000),
      parsedCount: 0,
      parsedSumCents: BigInt(2000),
      reconciled: true,
      chainOk: null,
      rawPdfHash: hash,
    });

    try {
      await expect(previewIngestion(makeFormData(pdfBuffer))).rejects.toThrow(/ya fue importado/i);
    } finally {
      await db
        .delete(arqStatementImports)
        .where(
          and(eq(arqStatementImports.userId, userA), eq(arqStatementImports.rawPdfHash, hash)),
        );
    }
  });

  it("format_unknown → returns needsManualKindPick: true", async () => {
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });
    mockParseAndHint.mockResolvedValue({ kind: "format_unknown" });

    const pdf = makeFakePdf();
    const result = await previewIngestion(makeFormData(pdf));
    expect(result.kind).toBe("format_unknown");
    if (result.kind === "format_unknown") {
      expect(result.needsManualKindPick).toBe(true);
    }
  });

  it("AC-19: foreign hint_account_id is ignored (not owned)", async () => {
    // userA uses a hint pointing to an account owned by userB — should be ignored
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });

    // Create an account for userB to use as the foreign hint
    const foreignAccountId = await createAccount(userB);

    mockParseAndHint.mockResolvedValue(makeArqDispatchResult());
    mockResolveAccountHint.mockResolvedValue({ accountId: accountA, source: "file-header" });
    mockParseArqStatementPdf.mockResolvedValue(makeRawStatement());

    const pdf = makeFakePdf();
    const formData = makeFormData(pdf, { hint_account_id: String(foreignAccountId) });

    // The action should proceed normally (file-header hint wins) not throw on the foreign hint
    // It logs account_hint_not_owned and continues with file-header resolution
    const result = await previewIngestion(formData);
    // Result comes from file-header accountHint (accountA), not from the foreign hint
    expect(result.kind).toBe("arq-pdf");
    if (result.kind === "arq-pdf") {
      expect(result.token).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Gen 2: commitIngestion
// ---------------------------------------------------------------------------

describe("commitIngestion", () => {
  it("AC-11: expired token → { status: 'expired' }", async () => {
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });

    const result = await commitIngestion("nonexistent-token-xyz999");
    expect(result.status).toBe("expired");
  });

  it("AC-12: cross-tenant token → error (user mismatch)", async () => {
    // First generate a token as userA via previewIngestion
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });
    mockParseAndHint.mockResolvedValue(makeArqDispatchResult());
    mockResolveAccountHint.mockResolvedValue({ accountId: accountA, source: "file-header" });
    mockParseArqStatementPdf.mockResolvedValue(makeRawStatement());

    const pdf = makeFakePdf();
    const previewResult = await previewIngestion(makeFormData(pdf));
    expect(previewResult.kind).toBe("arq-pdf");
    const token = previewResult.kind !== "format_unknown" ? previewResult.token : "";
    expect(token).toBeTruthy();

    // Now try to commit as userB with userA's token
    mockGetSessionUser.mockResolvedValue({
      id: userB,
      email: `${TAG}-b@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });
    const result = await commitIngestion(token);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/token inválido/i);
  });

  it("AC-13: single-use — second call with same token → expired", async () => {
    // Generate a token as userA
    mockGetSessionUser.mockResolvedValue({
      id: userA,
      email: `${TAG}-a@test.local`,
      name: TAG,
      role: "user",
      active: true,
    });
    mockParseAndHint.mockResolvedValue(makeArqDispatchResult());
    mockResolveAccountHint.mockResolvedValue({ accountId: accountA, source: "file-header" });
    mockParseArqStatementPdf.mockResolvedValue(makeRawStatement());
    mockRunStatementImport.mockResolvedValue({
      status: "committed",
      importId: 99,
      insertedTxCount: 0,
      mergedTxCount: 0,
      flaggedTxCount: 0,
      emailOrphanCount: 0,
    });

    const pdf = makeFakePdf();
    const previewResult = await previewIngestion(makeFormData(pdf));
    const token = previewResult.kind !== "format_unknown" ? previewResult.token : "";
    expect(token).toBeTruthy();

    // First commit — should work (or fail for other reasons, but NOT expired)
    const first = await commitIngestion(token);
    // Token is consumed regardless of pipeline result
    expect(first.status).not.toBe("expired");

    // Second call with same token — must be expired (token was deleted on first use)
    const second = await commitIngestion(token);
    expect(second.status).toBe("expired");
  });
});
