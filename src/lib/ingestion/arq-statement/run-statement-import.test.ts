// Integration tests for runStatementImport (#515).
//
// These tests hit the findash_test Postgres database (forced by vitest.setup.ts).
// Schema must be up to date: run `bun run db:migrate:test` before this suite.
//
// Tests cover:
//   - Happy path: 3-statement chain (Ene/Feb/Mar) — all reconcile ok and chain ok
//   - Failure: tx removed → reconciliation fails → status=reconcile_failed
//   - Failure: tx duplicated → reconciliation fails
//   - Chain mismatch: skip Feb, import Mar → chainOk=false but reconcile ok
//   - Re-import idempotency: same PDF hash → status=already_imported, no duplicate row
//   - Cross-tenant defense: account_id that doesn't belong to user_id → status=error

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, arqStatementImports, users } from "@/lib/db/schema";

import { runStatementImport } from "./run-statement-import";
import type { ParsedStatementTx } from "./type-handlers";
import type { RawStatement } from "./types";

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

const TAG = "ARQ_IMPORT_TEST";

let userId: number;
let accountId: number;
let otherUserId: number;
let otherAccountId: number;

async function cleanup(): Promise<void> {
  // arq_statement_imports → ON DELETE CASCADE from users, but let's be explicit
  await db.delete(arqStatementImports).where(
    sql`${arqStatementImports.userId} IN (
        SELECT id FROM users WHERE email LIKE ${TAG + "%"}
      )`,
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

async function createAccount(uid: number, label: string): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId: uid,
      name: `${TAG}-${label}`,
      institution: "ARQ (DolarApp)",
      institutionSlug: "other",
      currency: "USD",
      type: "savings",
    })
    .returning({ id: accounts.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Synthetic statement factories
// ---------------------------------------------------------------------------

function makeStatement(opts: {
  periodStart: Date;
  periodEnd: Date;
  balanceStartCents: bigint;
  totalCreditsCents: bigint;
  totalDebitsCents: bigint;
  balanceEndCents: bigint;
}): RawStatement {
  return {
    header: {
      accountHolder: "ALEJANDRO RAFAEL MARTINEZ MALDONADO",
      accountNumber: "211215197073",
      routingNumber: "101019644",
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      durationDays: Math.round(
        (opts.periodEnd.getTime() - opts.periodStart.getTime()) / 86_400_000,
      ),
      summary: {
        balanceStartCents: opts.balanceStartCents,
        totalCreditsCents: opts.totalCreditsCents,
        totalDebitsCents: opts.totalDebitsCents,
        balanceEndCents: opts.balanceEndCents,
      },
    },
    transactions: [],
  };
}

function parsedCredit(amountCents: bigint, id = "aabc"): ParsedStatementTx {
  return {
    kind: "transfer_received",
    occurredAt: new Date(Date.UTC(2026, 0, 10)),
    amountUsdc: amountCents,
    externalIdPrefix: "arq-stmt",
    externalId: id.padEnd(24, "0"),
    originalCurrency: "USD",
    originalAmount: amountCents,
    counterparty: "TEST",
    trmCopPerUsdc: null,
  };
}

function parsedDebit(amountCents: bigint, id = "bbcd"): ParsedStatementTx {
  return {
    kind: "purchase",
    occurredAt: new Date(Date.UTC(2026, 0, 15)),
    amountUsdc: -amountCents,
    externalIdPrefix: "arq-stmt",
    externalId: id.padEnd(24, "0"),
    merchant: "TIENDA",
    originalCurrency: "COP",
    originalAmount: amountCents * BigInt(3700),
    trmCopPerUsdc: 3700,
  };
}

// ---------------------------------------------------------------------------
// Statement data for the 3-month chain
//   Jan: start=26296, credits=206000, debits=159401, end=72895
//   Feb: start=72895, credits=209896, debits=202863, end=79928
//   Mar: start=79928, credits=100000, debits= 80000, end=99928
// ---------------------------------------------------------------------------

const JAN_STMT = makeStatement({
  periodStart: new Date(Date.UTC(2026, 0, 1)),
  periodEnd: new Date(Date.UTC(2026, 0, 31)),
  balanceStartCents: BigInt(26296),
  totalCreditsCents: BigInt(206000),
  totalDebitsCents: BigInt(159401),
  balanceEndCents: BigInt(72895),
});
const JAN_TXS: ParsedStatementTx[] = [
  parsedCredit(BigInt(206000), "jan-credit"),
  parsedDebit(BigInt(159401), "jan-debit"),
];

const FEB_STMT = makeStatement({
  periodStart: new Date(Date.UTC(2026, 1, 1)),
  periodEnd: new Date(Date.UTC(2026, 1, 28)),
  balanceStartCents: BigInt(72895),
  totalCreditsCents: BigInt(209896),
  totalDebitsCents: BigInt(202863),
  balanceEndCents: BigInt(79928),
});
const FEB_TXS: ParsedStatementTx[] = [
  parsedCredit(BigInt(209896), "feb-credit"),
  parsedDebit(BigInt(202863), "feb-debit"),
];

const MAR_STMT = makeStatement({
  periodStart: new Date(Date.UTC(2026, 2, 1)),
  periodEnd: new Date(Date.UTC(2026, 2, 31)),
  balanceStartCents: BigInt(79928),
  totalCreditsCents: BigInt(100000),
  totalDebitsCents: BigInt(80000),
  balanceEndCents: BigInt(99928),
});
const MAR_TXS: ParsedStatementTx[] = [
  parsedCredit(BigInt(100000), "mar-credit"),
  parsedDebit(BigInt(80000), "mar-debit"),
];

// ---------------------------------------------------------------------------
// Helper to build a fake parsePdf dep that returns a fixed statement + txs
// ---------------------------------------------------------------------------

function fakeParsePdf(stmt: RawStatement, txs: ParsedStatementTx[]) {
  // We inject at the runStatementImport level — but parsePdf only returns
  // RawStatement; txs are produced by parseStatementTransactions internally.
  // We need to patch parseStatementTransactions too. However, to keep tests
  // simple, we use the real parsePdf that returns the raw statement and let
  // parseStatementTransactions produce real-typed outputs from the raw lines.
  //
  // The cleanest approach for unit-style integration: we stub parsePdf to
  // return the synthetic RawStatement. Then we need the transactions array
  // in the RawStatement to produce the right parsed txs.
  //
  // Since parseStatementTransactions is pure and deterministic, we pre-build
  // the raw lines to match the desired parsed output instead of injecting
  // parsedTxs directly. For these tests we use a DIFFERENT approach: we
  // inject both parsePdf AND override parseStatementTransactions via a
  // wrapper dep.
  //
  // Actually: the cleanest pattern without over-engineering is to make the
  // `parsedTxs` come from the real parseStatementTransactions on the returned
  // RawStatement. We attach synthetic transactions to the RawStatement.transactions
  // list and let parseStatementTransactions handle them. This way we keep the
  // integration real.
  //
  // For the specific balance values we need, we use real raw lines matching
  // the parsed amounts. Below we build them inline.
  //
  // However, since building full raw lines that produce correct parsedTxs is
  // complex, we adopt the dep injection approach: expose a `_parseTxs` dep
  // alongside `parsePdf` to allow injecting pre-parsed tx lists.
  //
  // The current runStatementImport API only injects parsePdf. To avoid
  // over-engineering the API for testing only, we will instead use a real
  // RawStatement with transactions that will parse correctly.
  //
  // For these integration tests we attach synthetic raw lines that produce
  // known parseStatementTransactions results. Given the complexity, we take
  // the simplest route: since reconcileStatement is already tested in
  // balance.test.ts with synthetic ParsedStatementTx[], here we test the
  // full pipeline by building real RawStatements with real raw lines that
  // parseStatementTransactions can process.
  //
  // The parsedTxs param here is a hint for building real raw lines — ignored
  // in this helper which returns the stmt directly.
  void txs; // hint only
  return async (_buf: Buffer): Promise<RawStatement> => stmt;
}

// Build a RawStatement with real raw lines attached so the internal
// parseStatementTransactions call produces txs that match the expected summary.
function stmtWithRealLines(
  stmt: RawStatement,
  creditsCents: bigint,
  debitsCents: bigint,
): RawStatement {
  // One "Compra USDc" for the credits, one "Pago con tarjeta" (COP) for debits.
  return {
    ...stmt,
    transactions: [
      {
        date: stmt.header.periodStart,
        type: "Compra USDc",
        amountCents: creditsCents,
        equivalentCurrency: "USD",
        equivalentAmountCents: creditsCents,
        description: "CODEBRANCH LLC",
      },
      {
        date: stmt.header.periodStart,
        type: "Pago con tarjeta",
        amountCents: -debitsCents,
        equivalentCurrency: "COP",
        equivalentAmountCents: -(debitsCents * BigInt(3700)),
        description: "TIENDA D1",
      },
    ],
  };
}

// Pre-built statements with real raw lines
const JAN_REAL = stmtWithRealLines(JAN_STMT, BigInt(206000), BigInt(159401));
const FEB_REAL = stmtWithRealLines(FEB_STMT, BigInt(209896), BigInt(202863));
const MAR_REAL = stmtWithRealLines(MAR_STMT, BigInt(100000), BigInt(80000));

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await cleanup();
  userId = await createUser("main");
  accountId = await createAccount(userId, "arq-checking");
  otherUserId = await createUser("other");
  otherAccountId = await createAccount(otherUserId, "other-arq");
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// Happy path: 3-statement chain
// ---------------------------------------------------------------------------

describe("happy path — 3-statement chain (Jan → Feb → Mar)", () => {
  it("January: status=committed, reconciled=true, chainOk=null (first)", async () => {
    const result = await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      { userId, accountId, pdfBuffer: Buffer.from("jan"), pdfHash: `${TAG}-hash-jan` },
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(result.preview.reconcile.ok).toBe(true);
    expect(result.preview.chainCheck.chainOk).toBeNull(); // first import
    expect(result.importId).toBeGreaterThan(0);
  });

  it("January import is persisted in arq_statement_imports", async () => {
    const rows = await db.query.arqStatementImports.findMany({
      where: and(
        eq(arqStatementImports.userId, userId),
        eq(arqStatementImports.accountId, accountId),
      ),
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const jan = rows.find((r) => r.periodStart === "2026-01-01");
    expect(jan).toBeDefined();
    expect(jan?.reconciled).toBe(true);
    expect(jan?.chainOk).toBeNull();
  });

  it("February: status=committed, reconciled=true, chainOk=true", async () => {
    const result = await runStatementImport(
      { parsePdf: fakeParsePdf(FEB_REAL, FEB_TXS) },
      { userId, accountId, pdfBuffer: Buffer.from("feb"), pdfHash: `${TAG}-hash-feb` },
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(result.preview.reconcile.ok).toBe(true);
    // Feb start = Jan end = 72895 → chain ok
    expect(result.preview.chainCheck.chainOk).toBe(true);
    expect(result.preview.chainCheck.previousEndCents).toBe(BigInt(72895));
  });

  it("March: status=committed, reconciled=true, chainOk=true", async () => {
    const result = await runStatementImport(
      { parsePdf: fakeParsePdf(MAR_REAL, MAR_TXS) },
      { userId, accountId, pdfBuffer: Buffer.from("mar"), pdfHash: `${TAG}-hash-mar` },
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(result.preview.reconcile.ok).toBe(true);
    // Mar start = Feb end = 79928 → chain ok
    expect(result.preview.chainCheck.chainOk).toBe(true);
    expect(result.preview.chainCheck.previousEndCents).toBe(BigInt(79928));
  });
});

// ---------------------------------------------------------------------------
// Failure: transaction removed → reconciliation fails
// ---------------------------------------------------------------------------

describe("reconcile failure — missing transaction", () => {
  it("returns status=reconcile_failed when a debit is missing", async () => {
    // Statement declares credits=206000 debits=159401 but only credit line present
    const stmtMissingDebit = {
      ...JAN_STMT,
      header: { ...JAN_STMT.header, periodStart: new Date(Date.UTC(2026, 3, 1)) },
      transactions: [
        {
          date: new Date(Date.UTC(2026, 3, 10)),
          type: "Compra USDc",
          amountCents: BigInt(206000),
          equivalentCurrency: "USD" as const,
          equivalentAmountCents: BigInt(206000),
          description: "CODEBRANCH LLC",
        },
        // debit is MISSING — parser bug simulation
      ],
    };
    stmtMissingDebit.header = {
      ...JAN_STMT.header,
      periodStart: new Date(Date.UTC(2026, 3, 1)),
      periodEnd: new Date(Date.UTC(2026, 3, 30)),
    };

    const result = await runStatementImport(
      { parsePdf: async () => stmtMissingDebit },
      {
        userId,
        accountId,
        pdfBuffer: Buffer.from("missing-debit"),
        pdfHash: `${TAG}-hash-missing-debit`,
      },
    );

    expect(result.status).toBe("reconcile_failed");
    if (result.status !== "reconcile_failed") return;
    expect(result.preview.reconcile.ok).toBe(false);
    expect(result.preview.reconcile.errors.length).toBeGreaterThan(0);
  });

  it("reconcile_failed row is still written to arq_statement_imports (reconciled=false)", async () => {
    const rows = await db.query.arqStatementImports.findMany({
      where: and(
        eq(arqStatementImports.userId, userId),
        eq(arqStatementImports.rawPdfHash, `${TAG}-hash-missing-debit`),
      ),
    });
    expect(rows.length).toBe(1);
    expect(rows[0].reconciled).toBe(false);
    expect(rows[0].reconcileDiffCents).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure: duplicated transaction
// ---------------------------------------------------------------------------

describe("reconcile failure — duplicated transaction", () => {
  it("returns status=reconcile_failed when a credit is duplicated", async () => {
    const stmtDupCredit = {
      ...JAN_STMT,
      header: {
        ...JAN_STMT.header,
        periodStart: new Date(Date.UTC(2026, 4, 1)),
        periodEnd: new Date(Date.UTC(2026, 4, 31)),
      },
      transactions: [
        // credit duplicated
        {
          date: new Date(Date.UTC(2026, 4, 10)),
          type: "Compra USDc",
          amountCents: BigInt(206000),
          equivalentCurrency: "USD" as const,
          equivalentAmountCents: BigInt(206000),
          description: "CODEBRANCH LLC",
        },
        {
          date: new Date(Date.UTC(2026, 4, 10)),
          type: "Compra USDc",
          amountCents: BigInt(206000),
          equivalentCurrency: "USD" as const,
          equivalentAmountCents: BigInt(206000),
          description: "CODEBRANCH LLC",
        },
        {
          date: new Date(Date.UTC(2026, 4, 15)),
          type: "Pago con tarjeta",
          amountCents: -BigInt(159401),
          equivalentCurrency: "COP" as const,
          equivalentAmountCents: -BigInt(159401 * 3700),
          description: "TIENDA D1",
        },
      ],
    };

    const result = await runStatementImport(
      { parsePdf: async () => stmtDupCredit },
      {
        userId,
        accountId,
        pdfBuffer: Buffer.from("dup-credit"),
        pdfHash: `${TAG}-hash-dup-credit`,
      },
    );

    expect(result.status).toBe("reconcile_failed");
    if (result.status !== "reconcile_failed") return;
    expect(result.preview.reconcile.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Chain mismatch: skip Feb, import Mar → chainOk=false but reconcile ok
// ---------------------------------------------------------------------------

describe("chain mismatch — skip Feb, import directly to Mar", () => {
  it("March after Jan-only → chainOk=false, reconcile still ok", async () => {
    // Create a fresh user/account with no Feb row
    const freshUserId = await createUser("chain-gap");
    const freshAccountId = await createAccount(freshUserId, "gap-acct");

    // Import Jan for this user
    await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId: freshUserId,
        accountId: freshAccountId,
        pdfBuffer: Buffer.from("gap-jan"),
        pdfHash: `${TAG}-gap-hash-jan`,
      },
    );

    // Skip Feb — import Mar directly
    const result = await runStatementImport(
      { parsePdf: fakeParsePdf(MAR_REAL, MAR_TXS) },
      {
        userId: freshUserId,
        accountId: freshAccountId,
        pdfBuffer: Buffer.from("gap-mar"),
        pdfHash: `${TAG}-gap-hash-mar`,
      },
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;

    // Reconcile ok (Mar numbers balance internally)
    expect(result.preview.reconcile.ok).toBe(true);

    // Chain mismatch: Mar start=79928, Jan end=72895 → chainOk=false
    expect(result.preview.chainCheck.chainOk).toBe(false);
    expect(result.preview.chainCheck.diffCents).toBe(BigInt(79928 - 72895));
  });
});

// ---------------------------------------------------------------------------
// Chain check skips failed-reconcile prior rows
// ---------------------------------------------------------------------------

describe("chain check ignores reconcile_failed prior rows", () => {
  it("chainOk is null when the only prior import has reconciled=false", async () => {
    const uid = await createUser("chain-skip-failed");
    const aid = await createAccount(uid, "chain-skip-failed-acct");

    // Jan with declared balances that don't match — reconcile fails.
    const JAN_BROKEN = makeStatement({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      periodEnd: new Date(Date.UTC(2026, 0, 31)),
      balanceStartCents: BigInt(26296),
      totalCreditsCents: BigInt(206000),
      totalDebitsCents: BigInt(159401),
      balanceEndCents: BigInt(99999), // wrong: should be 72895
    });
    const JAN_BROKEN_REAL = stmtWithRealLines(JAN_BROKEN, BigInt(206000), BigInt(159401));

    const janResult = await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_BROKEN_REAL, JAN_TXS) },
      {
        userId: uid,
        accountId: aid,
        pdfBuffer: Buffer.from("jan-broken"),
        pdfHash: `${TAG}-chain-skip-jan`,
      },
    );
    expect(janResult.status).toBe("reconcile_failed");

    // Now import Feb — chainCheck should treat this user as "no prior verified
    // statement" and return chainOk=null, NOT chainOk=false from the broken Jan.
    const febResult = await runStatementImport(
      { parsePdf: fakeParsePdf(FEB_REAL, FEB_TXS) },
      {
        userId: uid,
        accountId: aid,
        pdfBuffer: Buffer.from("feb-after-broken-jan"),
        pdfHash: `${TAG}-chain-skip-feb`,
      },
    );

    expect(febResult.status).toBe("committed");
    if (febResult.status !== "committed") return;
    expect(febResult.preview.reconcile.ok).toBe(true);
    expect(febResult.preview.chainCheck.chainOk).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency: same PDF hash → early return, no duplicate row
// ---------------------------------------------------------------------------

describe("idempotency — re-import same PDF hash", () => {
  it("second import returns status=already_imported", async () => {
    // First import already happened in the 3-statement chain suite for Jan
    // Use a new user + new hash to avoid coupling
    const idem_userId = await createUser("idem");
    const idem_accountId = await createAccount(idem_userId, "idem-acct");

    const hash = `${TAG}-idem-hash-unique`;

    // First import
    await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId: idem_userId,
        accountId: idem_accountId,
        pdfBuffer: Buffer.from("idem"),
        pdfHash: hash,
      },
    );

    // Second import — same hash
    const result = await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId: idem_userId,
        accountId: idem_accountId,
        pdfBuffer: Buffer.from("idem"),
        pdfHash: hash,
      },
    );

    expect(result.status).toBe("already_imported");
  });

  it("only one row in arq_statement_imports after two identical imports", async () => {
    const hash = `${TAG}-idem-hash-count`;
    const uid = await createUser("idem-count");
    const aid = await createAccount(uid, "idem-count-acct");

    await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      { userId: uid, accountId: aid, pdfBuffer: Buffer.from("idem-cnt"), pdfHash: hash },
    );
    await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      { userId: uid, accountId: aid, pdfBuffer: Buffer.from("idem-cnt"), pdfHash: hash },
    );

    const rows = await db.query.arqStatementImports.findMany({
      where: and(eq(arqStatementImports.userId, uid), eq(arqStatementImports.rawPdfHash, hash)),
    });
    expect(rows.length).toBe(1);
  });

  it("different PDF for the same period returns status=error (period unique constraint)", async () => {
    // The hash-based idempotency catches identical PDFs. A user uploading an
    // amended statement (different bytes, same period) hits the
    // (user_id, account_id, period_start) unique constraint instead.
    const uid = await createUser("period-conflict");
    const aid = await createAccount(uid, "period-conflict-acct");

    const first = await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId: uid,
        accountId: aid,
        pdfBuffer: Buffer.from("first"),
        pdfHash: `${TAG}-period-hash-1`,
      },
    );
    expect(first.status).toBe("committed");

    const second = await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId: uid,
        accountId: aid,
        pdfBuffer: Buffer.from("second-different"),
        pdfHash: `${TAG}-period-hash-2`,
      },
    );

    expect(second.status).toBe("error");
    if (second.status !== "error") return;
    expect(second.error).toMatch(/already been imported/i);

    const rows = await db.query.arqStatementImports.findMany({
      where: eq(arqStatementImports.userId, uid),
    });
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant defense: account_id not belonging to user_id → status=error
// ---------------------------------------------------------------------------

describe("cross-tenant defense", () => {
  it("rejects when account_id belongs to a different user", async () => {
    // otherAccountId belongs to otherUserId — not userId
    const result = await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId, // this user
        accountId: otherAccountId, // account owned by otherUser
        pdfBuffer: Buffer.from("cross-tenant"),
        pdfHash: `${TAG}-hash-cross-tenant`,
      },
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error).toContain("does not belong to user");
  });

  it("does not create any arq_statement_imports row on cross-tenant rejection", async () => {
    const rows = await db.query.arqStatementImports.findMany({
      where: eq(arqStatementImports.rawPdfHash, `${TAG}-hash-cross-tenant`),
    });
    expect(rows.length).toBe(0);
  });

  it("user A cannot see user B's import by using the same hash", async () => {
    // Two distinct users each import the same PDF content (same hash).
    // The idempotency check is scoped by user_id, so each user proceeds
    // independently and both get committed.
    const sharedHash = `${TAG}-shared-scope-hash`;

    // Create fresh users/accounts so we don't collide with the chain test's Jan row
    const scopeUserA = await createUser("scope-a");
    const scopeAcctA = await createAccount(scopeUserA, "scope-a-acct");
    const scopeUserB = await createUser("scope-b");
    const scopeAcctB = await createAccount(scopeUserB, "scope-b-acct");

    await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId: scopeUserA,
        accountId: scopeAcctA,
        pdfBuffer: Buffer.from("shared"),
        pdfHash: sharedHash,
      },
    );

    // User B imports same file → should proceed normally (not treated as already_imported)
    const otherResult = await runStatementImport(
      { parsePdf: fakeParsePdf(JAN_REAL, JAN_TXS) },
      {
        userId: scopeUserB,
        accountId: scopeAcctB,
        pdfBuffer: Buffer.from("shared"),
        pdfHash: sharedHash,
      },
    );

    // User B has their own import — hash is scoped per user
    expect(otherResult.status).toBe("committed");
  });
});
