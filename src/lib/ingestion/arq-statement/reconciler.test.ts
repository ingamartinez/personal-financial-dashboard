// Integration tests for reconcileEmailVsStatement (#517).
//
// These tests hit the findash_test Postgres database (forced by vitest.setup.ts).
// Schema must be up to date: run `bun run db:migrate:test` before this suite.
//
// Test matrix:
//   1. Match → MERGE: gmail_arq tx + matching statement tx → 1 tx, primary source
//      unchanged ('gmail_arq'), secondary_source='arq_statement', statement metadata set.
//   2. No match → INSERT: statement-only purchase → new tx with source='arq_statement'.
//   3. Mismatch → FLAG: amount diff > 1 cent → source_mismatch=true on merge.
//   4. Email orphan → FLAG: gmail_arq tx in period without statement counterpart
//      → source_mismatch=true, reason='email_orphan'.
//   5. Tenant safety: scoped by user_id; other-user's txs are invisible.
//   6. Idempotency: re-running with same (importId, parsedTxs) is a no-op.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, arqStatementImports, transactions, users } from "@/lib/db/schema";

import type { ParsedStatementTx } from "./type-handlers";
import { reconcileEmailVsStatement } from "./reconciler";

// ---------------------------------------------------------------------------
// Helpers & fixtures
// ---------------------------------------------------------------------------

const TAG = "ARQ_RECONCILER_TEST";

let userId: number;
let accountId: number;
let otherUserId: number;
let otherAccountId: number;

// Synthetic arq_statement_import id (audit row) for tests.
let importId: number;

async function cleanup(): Promise<void> {
  // transactions → delete by user
  await db
    .delete(transactions)
    .where(sql`${transactions.userId} IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`);
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
      name: `${TAG}-arq-account`,
      institution: "ARQ (DolarApp)",
      institutionSlug: "other",
      currency: "USD",
      type: "savings",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createImportAuditRow(uid: number, acctId: number): Promise<number> {
  const [row] = await db
    .insert(arqStatementImports)
    .values({
      userId: uid,
      accountId: acctId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      declaredStartCents: BigInt(0),
      declaredEndCents: BigInt(0),
      parsedCount: 0,
      parsedSumCents: BigInt(0),
      reconciled: true,
      rawPdfHash: `${TAG}-test-hash-${uid}-${acctId}`,
    })
    .returning({ id: arqStatementImports.id });
  return row.id;
}

/**
 * Insert a gmail_arq email tx directly (simulates what email-arq.ts writes).
 */
async function insertEmailTx(opts: {
  userId: number;
  accountId: number;
  amountCents: bigint;
  occurredAt: Date;
  merchant: string;
  externalId: string;
}): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: opts.accountId,
      occurredAt: opts.occurredAt,
      amountCents: opts.amountCents,
      currency: "USD",
      descriptionRaw: `Email: ${opts.merchant}`,
      merchant: opts.merchant,
      source: "gmail_arq",
      channel: "transfer",
      externalId: opts.externalId,
      rawData: {
        kind: "transfer_sent",
        arq: { recipient_name: opts.merchant },
        fx: {
          originalCurrency: "COP",
          originalAmountCents: "200000000",
          trmToAccountCurrency: 4000,
          trmSource: "email_implied",
        },
      },
    })
    .returning({ id: transactions.id });
  return row.id;
}

/**
 * Build a ParsedStatementTx for a transfer_sent (Venta USDc).
 */
function makeTransferSentTx(opts: {
  occurredAt: Date;
  amountUsdc: bigint;
  recipientName: string;
  externalId: string;
}): ParsedStatementTx {
  return {
    kind: "transfer_sent",
    occurredAt: opts.occurredAt,
    amountUsdc: opts.amountUsdc,
    externalIdPrefix: "arq-stmt",
    externalId: opts.externalId,
    originalCurrency: "COP",
    originalAmount:
      (opts.amountUsdc < BigInt(0) ? -opts.amountUsdc : opts.amountUsdc) * BigInt(4000),
    recipientName: opts.recipientName,
    trmCopPerUsdc: 4000,
  };
}

/**
 * Build a ParsedStatementTx for a purchase (Pago con tarjeta).
 */
function makePurchaseTx(opts: {
  occurredAt: Date;
  amountUsdc: bigint;
  merchant: string;
  externalId: string;
}): ParsedStatementTx {
  return {
    kind: "purchase",
    occurredAt: opts.occurredAt,
    amountUsdc: opts.amountUsdc,
    externalIdPrefix: "arq-stmt",
    externalId: opts.externalId,
    merchant: opts.merchant,
    originalCurrency: "COP",
    originalAmount:
      (opts.amountUsdc < BigInt(0) ? -opts.amountUsdc : opts.amountUsdc) * BigInt(4000),
    trmCopPerUsdc: 4000,
  };
}

const PERIOD = {
  start: new Date(Date.UTC(2026, 2, 1)), // 2026-03-01
  end: new Date(Date.UTC(2026, 2, 31, 23, 59, 59)),
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await cleanup();
  userId = await createUser("main");
  accountId = await createAccount(userId);
  otherUserId = await createUser("other");
  otherAccountId = await createAccount(otherUserId);
  importId = await createImportAuditRow(userId, accountId);
});

afterAll(async () => {
  await cleanup();
  // Only this test file calls db.$client.end() — see drizzle-error-wrapping-test-pattern memory.
  await db.$client.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcileEmailVsStatement", () => {
  describe("MERGE — matching email + statement tx", () => {
    it("updates existing gmail_arq tx with statement metadata; primary source unchanged", async () => {
      const occurredAt = new Date(Date.UTC(2026, 2, 5, 12, 0, 0));
      const amountCents = BigInt(-56381); // -563.81 USDc (negative = debit)

      const emailTxId = await insertEmailTx({
        userId,
        accountId,
        amountCents,
        occurredAt,
        merchant: "Maria Eugenia",
        externalId: `arq-email-test-merge-1`,
      });

      const stmtExternalId = "arq-stmt-merge-test-1234567";
      const stmtTx = makeTransferSentTx({
        occurredAt,
        amountUsdc: amountCents,
        recipientName: "maria eugenia", // different capitalisation
        externalId: stmtExternalId,
      });

      const result = await reconcileEmailVsStatement(
        { db },
        {
          userId,
          accountId,
          importId,
          period: PERIOD,
          parsedTxs: [stmtTx],
        },
      );

      expect(result.mergedCount).toBe(1);
      expect(result.insertedCount).toBe(0);
      expect(result.flaggedCount).toBe(0);
      expect(result.details[0].kind).toBe("merge");

      // Verify the existing tx was updated — source MUST remain 'gmail_arq'.
      const updated = await db.query.transactions.findFirst({
        where: eq(transactions.id, emailTxId),
      });

      expect(updated).toBeDefined();
      expect(updated!.source).toBe("gmail_arq"); // primary source unchanged
      expect(updated!.secondarySource).toBe("arq_statement");
      expect(updated!.externalIdStatement).toBe(stmtExternalId);
      expect(updated!.arqStatementImportId).toBe(importId);
      expect(updated!.sourceMismatch).toBe(false);

      // Verify amount/occurred_at preserved (first-in wins).
      expect(updated!.amountCents).toBe(amountCents);
    });
  });

  describe("INSERT — statement-only tx (no email counterpart)", () => {
    it("inserts new tx with source=arq_statement for purchase not in email", async () => {
      const occurredAt = new Date(Date.UTC(2026, 2, 10, 14, 0, 0));
      const amountCents = BigInt(-2500); // -25.00 USDc

      const stmtExternalId = "arq-stmt-insert-test-1234567";
      const stmtTx = makePurchaseTx({
        occurredAt,
        amountUsdc: amountCents,
        merchant: "Netflix",
        externalId: stmtExternalId,
      });

      const result = await reconcileEmailVsStatement(
        { db },
        {
          userId,
          accountId,
          importId,
          period: PERIOD,
          parsedTxs: [stmtTx],
        },
      );

      expect(result.insertedCount).toBe(1);

      // Verify the new tx was written with arq_statement source.
      const insertDecision = result.details.find((d) => d.kind === "insert");
      expect(insertDecision).toBeDefined();
      const inserted = insertDecision as { kind: "insert"; newTxId: number };

      const tx = await db.query.transactions.findFirst({
        where: and(
          eq(transactions.id, inserted.newTxId),
          eq(transactions.userId, userId),
          eq(transactions.accountId, accountId),
        ),
      });

      expect(tx).toBeDefined();
      expect(tx!.source).toBe("arq_statement");
      expect(tx!.currency).toBe("USD");
      expect(tx!.amountCents).toBe(amountCents);
      expect(tx!.arqStatementImportId).toBe(importId);
      expect(tx!.externalId).toBe(stmtExternalId);
    });
  });

  describe("Ambiguous email match — multiple equally-close candidates", () => {
    it("inserts the statement tx flagged source_mismatch instead of dropping it", async () => {
      // Two email candidates equidistant from the statement occurredAt and
      // identical amount/counterparty → ambiguous. The reconciler must NOT
      // silently drop the statement line; it must INSERT it flagged for review.
      const stmtOccurredAt = new Date(Date.UTC(2026, 2, 8, 12, 0, 0));
      const amountCents = BigInt(-44400);

      // Candidate A: 1 hour before
      await insertEmailTx({
        userId,
        accountId,
        amountCents,
        occurredAt: new Date(stmtOccurredAt.getTime() - 60 * 60 * 1000),
        merchant: "ambiguous-payee",
        externalId: "arq-email-ambig-A",
      });
      // Candidate B: 1 hour after — same delta as A
      await insertEmailTx({
        userId,
        accountId,
        amountCents,
        occurredAt: new Date(stmtOccurredAt.getTime() + 60 * 60 * 1000),
        merchant: "ambiguous-payee",
        externalId: "arq-email-ambig-B",
      });

      const stmtExternalId = "arq-stmt-ambig-test-1234567";
      const stmtTx = makeTransferSentTx({
        occurredAt: stmtOccurredAt,
        amountUsdc: amountCents,
        recipientName: "ambiguous-payee",
        externalId: stmtExternalId,
      });

      const result = await reconcileEmailVsStatement(
        { db },
        {
          userId,
          accountId,
          importId,
          period: PERIOD,
          parsedTxs: [stmtTx],
        },
      );

      expect(result.insertedCount).toBe(1);
      expect(result.mergedCount).toBe(0);
      // 1 from the ambiguous-insert + 2 from email-orphan flags on the
      // unmatched candidates (they fall in PERIOD without a counterpart).
      expect(result.flaggedCount).toBeGreaterThanOrEqual(1);

      const decision = result.details.find(
        (d) => d.kind === "insert" && (d as { mismatchReason?: string }).mismatchReason,
      ) as { kind: "insert"; newTxId: number; mismatchReason?: string } | undefined;
      expect(decision).toBeDefined();
      expect(decision!.mismatchReason).toBe("ambiguous_email_match");

      const inserted = await db.query.transactions.findFirst({
        where: eq(transactions.id, decision!.newTxId),
      });
      expect(inserted!.source).toBe("arq_statement");
      expect(inserted!.sourceMismatch).toBe(true);
      expect(inserted!.sourceMismatchDetails!.diffs[0]!.field).toBe("ambiguous_email_match");
    });
  });

  describe("FLAG — amount mismatch > 1 cent", () => {
    it("merges but flags source_mismatch when amounts diverge > 1 cent", async () => {
      const occurredAt = new Date(Date.UTC(2026, 2, 15, 10, 0, 0));
      const emailAmount = BigInt(-33705); // email says 337.05 USDc
      const stmtAmount = BigInt(-33700); // statement says 337.00 USDc — diff = 5c > 1c tolerance

      const emailTxId = await insertEmailTx({
        userId,
        accountId,
        amountCents: emailAmount,
        occurredAt,
        merchant: "Felipe Rodriguez",
        externalId: "arq-email-test-mismatch-1",
      });

      const stmtTx = makeTransferSentTx({
        occurredAt,
        amountUsdc: stmtAmount,
        recipientName: "Felipe Rodriguez",
        externalId: "arq-stmt-mismatch-test-12345678",
      });

      const result = await reconcileEmailVsStatement(
        { db },
        {
          userId,
          accountId,
          importId,
          period: PERIOD,
          parsedTxs: [stmtTx],
        },
      );

      // Should still merge (not skip), but flagged.
      expect(result.mergedCount).toBe(1);
      expect(result.flaggedCount).toBeGreaterThanOrEqual(1);

      const mergeDecision = result.details.find((d) => d.kind === "merge") as
        | { kind: "merge"; mismatchReason?: string }
        | undefined;
      expect(mergeDecision).toBeDefined();
      expect(mergeDecision!.mismatchReason).toBe("amount_diverge");

      const updated = await db.query.transactions.findFirst({
        where: eq(transactions.id, emailTxId),
      });
      expect(updated!.sourceMismatch).toBe(true);
      expect(updated!.sourceMismatchDetails).toBeDefined();
      expect(updated!.sourceMismatchDetails!.fromSource).toBe("gmail_arq");
      expect(updated!.sourceMismatchDetails!.toSource).toBe("arq_statement");
    });
  });

  describe("Email orphan — gmail_arq tx with no statement counterpart", () => {
    it("flags gmail_arq tx in period as source_mismatch with email_orphan reason", async () => {
      const occurredAt = new Date(Date.UTC(2026, 2, 20, 9, 0, 0));

      // Insert a gmail_arq tx in the period — it will NOT appear in parsedTxs.
      const orphanTxId = await insertEmailTx({
        userId,
        accountId,
        amountCents: BigInt(-10000),
        occurredAt,
        merchant: "Daniela Perez",
        externalId: "arq-email-test-orphan-1",
      });

      // Run reconciler with EMPTY parsedTxs — no statement lines for this period.
      const result = await reconcileEmailVsStatement(
        { db },
        {
          userId,
          accountId,
          importId,
          period: PERIOD,
          parsedTxs: [],
        },
      );

      expect(result.emailOrphanCount).toBeGreaterThanOrEqual(1);
      expect(result.flaggedCount).toBeGreaterThanOrEqual(1);

      const orphan = await db.query.transactions.findFirst({
        where: eq(transactions.id, orphanTxId),
      });
      expect(orphan!.sourceMismatch).toBe(true);
      expect(orphan!.sourceMismatchDetails!.diffs[0].field).toBe("email_orphan");
    });
  });

  describe("Tenant safety", () => {
    it("does not merge email txs belonging to another user", async () => {
      const occurredAt = new Date(Date.UTC(2026, 2, 25, 8, 0, 0));
      const amountCents = BigInt(-5000);

      // Insert email tx under the OTHER user.
      const otherImportId = await createImportAuditRow(otherUserId, otherAccountId);
      const otherEmailTxId = await insertEmailTx({
        userId: otherUserId,
        accountId: otherAccountId,
        amountCents,
        occurredAt,
        merchant: "Carlos Garcia",
        externalId: "arq-email-test-tenant-other",
      });

      // Run reconciler for the MAIN user with a matching statement line.
      const stmtTx = makeTransferSentTx({
        occurredAt,
        amountUsdc: amountCents,
        recipientName: "Carlos Garcia",
        externalId: "arq-stmt-tenant-test-1234567",
      });

      const result = await reconcileEmailVsStatement(
        { db },
        {
          userId, // main user — should NOT see otherUser's txs
          accountId,
          importId,
          period: PERIOD,
          parsedTxs: [stmtTx],
        },
      );

      // The statement tx had no email counterpart in userId's account → INSERT.
      expect(result.insertedCount).toBe(1);
      expect(result.mergedCount).toBe(0);

      // The other user's email tx MUST NOT have been touched.
      const otherTx = await db.query.transactions.findFirst({
        where: and(eq(transactions.id, otherEmailTxId), eq(transactions.userId, otherUserId)),
      });
      expect(otherTx!.secondarySource).toBeNull();
      expect(otherTx!.externalIdStatement).toBeNull();
      expect(otherTx!.arqStatementImportId).toBeNull();

      // Cleanup other import to avoid polluting other tests.
      await db.delete(arqStatementImports).where(eq(arqStatementImports.id, otherImportId));
    });
  });

  describe("Idempotency", () => {
    it("re-running with the same importId and parsedTxs does not duplicate or re-merge", async () => {
      const occurredAt = new Date(Date.UTC(2026, 2, 28, 11, 0, 0));
      const amountCents = BigInt(-7800);

      const emailTxId = await insertEmailTx({
        userId,
        accountId,
        amountCents,
        occurredAt,
        merchant: "Luisa Hernandez",
        externalId: "arq-email-test-idempotent-1",
      });

      const stmtExternalId = "arq-stmt-idempotent-test-12345";
      const stmtTx = makeTransferSentTx({
        occurredAt,
        amountUsdc: amountCents,
        recipientName: "Luisa Hernandez",
        externalId: stmtExternalId,
      });

      // First run.
      const run1 = await reconcileEmailVsStatement(
        { db },
        { userId, accountId, importId, period: PERIOD, parsedTxs: [stmtTx] },
      );
      expect(run1.mergedCount).toBe(1);

      // Second run with same data.
      const run2 = await reconcileEmailVsStatement(
        { db },
        { userId, accountId, importId, period: PERIOD, parsedTxs: [stmtTx] },
      );

      // The tx already has externalIdStatement set — reconciler skips it.
      expect(run2.mergedCount).toBe(0);
      const skipDecision = run2.details.find(
        (d) => d.kind === "skip" && "reason" in d && d.reason === "idempotent_already_merged",
      );
      expect(skipDecision).toBeDefined();

      // DB row is not mutated a second time — updatedAt should remain stable-ish.
      const tx = await db.query.transactions.findFirst({
        where: eq(transactions.id, emailTxId),
      });
      expect(tx!.secondarySource).toBe("arq_statement");
      expect(tx!.externalIdStatement).toBe(stmtExternalId);
    });
  });

  describe("skip entries", () => {
    it("skips ParsedStatementTx with kind=skip without writing to DB", async () => {
      const skipTx: ParsedStatementTx = {
        kind: "skip",
        reason: "Unknown transaction type: Foo",
        raw: {
          date: new Date(Date.UTC(2026, 2, 5)),
          type: "Foo",
          description: "test",
          amountCents: BigInt(-100),
          equivalentCurrency: null,
          equivalentAmountCents: null,
        },
      };

      const result = await reconcileEmailVsStatement(
        { db },
        { userId, accountId, importId, period: PERIOD, parsedTxs: [skipTx] },
      );

      expect(result.insertedCount).toBe(0);
      expect(result.mergedCount).toBe(0);
      const skipDecision = result.details.find((d) => d.kind === "skip");
      expect(skipDecision).toBeDefined();
    });
  });
});
