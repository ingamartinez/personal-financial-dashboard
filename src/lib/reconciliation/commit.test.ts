import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  reconciliationDecisions,
  statementImports,
  transactions,
  users,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import { commitReconciliation, hashFileBuffer, recordReconciliationDecision } from "./commit";
import type { ParsedStatement, ParsedStatementRow } from "./parsers/types";
import type { MatchingPlan } from "./engine/types";

const TAG = "RECON_COMMIT_TEST";

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number, currency: "COP" | "USD" = "COP"): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} acct`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "savings",
      currency,
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createExistingTxn(
  userId: number,
  accountId: number,
  amountCents: bigint,
  occurredAt: Date,
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt,
      amountCents,
      currency: "COP",
      descriptionRaw: `${TAG} existing`,
      source: "manual",
      channel: "bank",
    })
    .returning({ id: transactions.id });
  return row.id;
}

function buildParsed(
  rows: ParsedStatementRow[],
  overrides: Partial<ParsedStatement> = {},
): ParsedStatement {
  const times = rows.map((r) => r.occurredAt.getTime());
  return {
    bank: "bancolombia",
    format: "bancolombia_savings",
    periodStart: new Date(Math.min(...times)),
    periodEnd: new Date(Math.max(...times)),
    rowCount: rows.length,
    balanceAtEndCents: null,
    rows,
    ...overrides,
  };
}

async function cleanupUser(userId: number): Promise<void> {
  const txnIds = (
    await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userId))
  ).map((r) => r.id);
  if (txnIds.length > 0) {
    await db.delete(reconciliationDecisions).where(inArray(reconciliationDecisions.txnId, txnIds));
  }
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(statementImports).where(eq(statementImports.userId, userId));
  await db.delete(accounts).where(eq(accounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe("commitReconciliation — integration against findash_test", () => {
  let userId!: number;
  let accountId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.${Date.now()}@test.local`);
    accountId = await createAccount(userId);
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("inserts new rows when no existing txns match", async () => {
    const date = new Date("2026-04-10T05:00:00Z");
    const parsed = buildParsed([
      {
        occurredAt: date,
        amountCents: BigInt(62_000_00),
        currency: "COP",
        direction: "out",
        descriptionRaw: `${TAG} new row`,
        rawData: { referencia: "TEST_NEW" },
        isMetadata: false,
      },
    ]);
    const plan: MatchingPlan = {
      decisions: [
        {
          statementRowIndex: 0,
          action: "insert_new",
          matchedTxnId: null,
          matchScore: 0,
          matchReason: "no_match",
        },
      ],
      flaggedExisting: [],
      summary: { matched: 0, newInserts: 1, flaggedExisting: 0 },
    };
    const result = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed,
      plan,
      fileHash: hashFileBuffer(Buffer.from(`${TAG}-insert-only`)),
    });
    expect(result.status).toBe("applied");
    expect(result.inserted).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.flagged).toBe(0);

    const inserted = await db
      .select()
      .from(transactions)
      .where(eq(transactions.statementImportId, result.statementImportId));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amountCents).toBe(BigInt(-62_000_00));
    expect(inserted[0].source).toBe("csv_reconcile");
    expect(inserted[0].channel).toBe("bank");
    expect(inserted[0].reconciliationStatus).toBe("imported_from_statement");

    const [imp] = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.id, result.statementImportId));
    expect(imp.txnCount).toBe(1);
  });

  it("marks matched existing txn as matched + links to statement_import", async () => {
    const date = new Date("2026-04-11T05:00:00Z");
    const existingId = await createExistingTxn(userId, accountId, BigInt(-50_000_00), date);

    const parsed = buildParsed([
      {
        occurredAt: date,
        amountCents: BigInt(50_000_00),
        currency: "COP",
        direction: "out",
        descriptionRaw: `${TAG} match`,
        rawData: {},
        isMetadata: false,
      },
    ]);
    const plan: MatchingPlan = {
      decisions: [
        {
          statementRowIndex: 0,
          action: "match",
          matchedTxnId: existingId,
          matchScore: 100,
          matchReason: "amount_date_exact",
        },
      ],
      flaggedExisting: [],
      summary: { matched: 1, newInserts: 0, flaggedExisting: 0 },
    };
    const result = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed,
      plan,
      fileHash: hashFileBuffer(Buffer.from(`${TAG}-match-case`)),
    });
    expect(result.status).toBe("applied");
    expect(result.matched).toBe(1);

    const [updated] = await db.select().from(transactions).where(eq(transactions.id, existingId));
    expect(updated.reconciliationStatus).toBe("matched");
    expect(updated.reconciledAt).not.toBeNull();
    expect(updated.statementImportId).toBe(result.statementImportId);
  });

  it("flags existing txns listed in flaggedExisting without linking them to the statement", async () => {
    const date = new Date("2026-04-12T05:00:00Z");
    const orphanId = await createExistingTxn(userId, accountId, BigInt(-7_000_00), date);

    const parsed = buildParsed([
      {
        occurredAt: date,
        amountCents: BigInt(9_000_00),
        currency: "COP",
        direction: "out",
        descriptionRaw: `${TAG} flag test new`,
        rawData: {},
        isMetadata: false,
      },
    ]);
    const plan: MatchingPlan = {
      decisions: [
        {
          statementRowIndex: 0,
          action: "insert_new",
          matchedTxnId: null,
          matchScore: 0,
          matchReason: "no_match",
        },
      ],
      flaggedExisting: [{ txnId: orphanId, reason: "no_statement_match" }],
      summary: { matched: 0, newInserts: 1, flaggedExisting: 1 },
    };
    const result = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed,
      plan,
      fileHash: hashFileBuffer(Buffer.from(`${TAG}-flag-case`)),
    });
    expect(result.flagged).toBe(1);

    const [flagged] = await db.select().from(transactions).where(eq(transactions.id, orphanId));
    expect(flagged.reconciliationStatus).toBe("flagged");
    expect(flagged.statementImportId).toBeNull();
  });

  it("idempotent: same fileHash twice returns already_imported and does not re-write", async () => {
    const date = new Date("2026-04-13T05:00:00Z");
    const parsed = buildParsed([
      {
        occurredAt: date,
        amountCents: BigInt(1_000_00),
        currency: "COP",
        direction: "in",
        descriptionRaw: `${TAG} idempotent`,
        rawData: {},
        isMetadata: false,
      },
    ]);
    const plan: MatchingPlan = {
      decisions: [
        {
          statementRowIndex: 0,
          action: "insert_new",
          matchedTxnId: null,
          matchScore: 0,
          matchReason: "no_match",
        },
      ],
      flaggedExisting: [],
      summary: { matched: 0, newInserts: 1, flaggedExisting: 0 },
    };
    const hash = hashFileBuffer(Buffer.from(`${TAG}-idempotency`));
    const first = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed,
      plan,
      fileHash: hash,
    });
    const second = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed,
      plan,
      fileHash: hash,
    });
    expect(first.status).toBe("applied");
    expect(second.status).toBe("already_imported");
    expect(second.statementImportId).toBe(first.statementImportId);
    expect(second.inserted).toBe(0);

    const rows = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.statementImportId, first.statementImportId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("persists userBalanceAtEndCents when provided, falls back to parsed otherwise", async () => {
    const date = new Date("2026-04-15T05:00:00Z");
    const buildRun = (tag: string) =>
      buildParsed([
        {
          occurredAt: date,
          amountCents: BigInt(1_000_00),
          currency: "COP",
          direction: "in",
          descriptionRaw: `${TAG} ${tag}`,
          rawData: {},
          isMetadata: false,
        },
      ]);
    const plan: MatchingPlan = {
      decisions: [
        {
          statementRowIndex: 0,
          action: "insert_new",
          matchedTxnId: null,
          matchScore: 0,
          matchReason: "no_match",
        },
      ],
      flaggedExisting: [],
      summary: { matched: 0, newInserts: 1, flaggedExisting: 0 },
    };

    const withUserBalance = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed: buildRun("user-balance"),
      plan,
      fileHash: hashFileBuffer(Buffer.from(`${TAG}-user-balance`)),
      userBalanceAtEndCents: BigInt(12_345_678_00),
    });
    const [impWithUser] = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.id, withUserBalance.statementImportId));
    expect(impWithUser.balanceAtEndCents).toBe(BigInt(12_345_678_00));

    const noUserBalance = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed: buildRun("no-user-balance"),
      plan,
      fileHash: hashFileBuffer(Buffer.from(`${TAG}-no-user-balance`)),
      userBalanceAtEndCents: null,
    });
    const [impNoUser] = await db
      .select()
      .from(statementImports)
      .where(eq(statementImports.id, noUserBalance.statementImportId));
    expect(impNoUser.balanceAtEndCents).toBeNull();
  });

  it("preserves sign at persistence: direction='in' → positive cents, 'out' → negative", async () => {
    const date = new Date("2026-04-14T05:00:00Z");
    const parsed = buildParsed([
      {
        occurredAt: date,
        amountCents: BigInt(5_000_00),
        currency: "COP",
        direction: "in",
        descriptionRaw: `${TAG} ingreso`,
        rawData: {},
        isMetadata: false,
      },
      {
        occurredAt: date,
        amountCents: BigInt(3_000_00),
        currency: "COP",
        direction: "out",
        descriptionRaw: `${TAG} gasto`,
        rawData: {},
        isMetadata: false,
      },
    ]);
    const plan: MatchingPlan = {
      decisions: [
        {
          statementRowIndex: 0,
          action: "insert_new",
          matchedTxnId: null,
          matchScore: 0,
          matchReason: "no_match",
        },
        {
          statementRowIndex: 1,
          action: "insert_new",
          matchedTxnId: null,
          matchScore: 0,
          matchReason: "no_match",
        },
      ],
      flaggedExisting: [],
      summary: { matched: 0, newInserts: 2, flaggedExisting: 0 },
    };
    const result = await commitReconciliation({
      userId,
      account: { id: accountId, currency: "COP" },
      parsed,
      plan,
      fileHash: hashFileBuffer(Buffer.from(`${TAG}-sign-case`)),
    });
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.statementImportId, result.statementImportId));
    const ingreso = rows.find((r) => r.descriptionRaw.includes("ingreso"));
    const gasto = rows.find((r) => r.descriptionRaw.includes("gasto"));
    expect(ingreso?.amountCents).toBe(BigInt(5_000_00));
    expect(gasto?.amountCents).toBe(BigInt(-3_000_00));
  });
});

describe("recordReconciliationDecision — integration", () => {
  let userId!: number;
  let accountId!: number;
  let txnId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.review.${Date.now()}@test.local`);
    accountId = await createAccount(userId);
    txnId = await createExistingTxn(userId, accountId, BigInt(-1_000_00), new Date());
    await db
      .update(transactions)
      .set({ reconciliationStatus: "flagged" })
      .where(eq(transactions.id, txnId));
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("records a 'kept' decision and resets status to unreconciled", async () => {
    await recordReconciliationDecision({ userId, txnId, action: "kept", note: "real charge" });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(row.reconciliationStatus).toBe("unreconciled");
    const [decision] = await db
      .select()
      .from(reconciliationDecisions)
      .where(eq(reconciliationDecisions.txnId, txnId));
    expect(decision.action).toBe("kept");
    expect(decision.note).toBe("real charge");
  });

  it("rejects 'merged_into' without a target id", async () => {
    await expect(
      recordReconciliationDecision({ userId, txnId, action: "merged_into" }),
    ).rejects.toThrow(/mergedIntoTxnId/);
  });
});

describe("recordReconciliationDecision — merge_into path", () => {
  let userId!: number;
  let accountId!: number;

  beforeAll(async () => {
    userId = await createUser(`${TAG.toLowerCase()}.merge.${Date.now()}@test.local`);
    accountId = await createAccount(userId);
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("merges flagged into target: flagged survives with statement data, target is deleted", async () => {
    // Set up: one flagged row (with its category) and one statement-imported target.
    const flaggedDate = new Date("2026-04-10T05:00:00Z");
    const [flaggedRow] = await db
      .insert(transactions)
      .values({
        userId,
        accountId,
        occurredAt: flaggedDate,
        amountCents: BigInt(-25_448_00),
        currency: "COP",
        descriptionRaw: `${TAG} sms-captured`,
        source: "sms",
        channel: "bank",
        categorySlug: "mercado",
        reconciliationStatus: "flagged",
      })
      .returning({ id: transactions.id });

    const targetDate = new Date("2026-04-10T05:00:00Z");
    const [imp] = await db
      .insert(statementImports)
      .values({
        userId,
        accountId,
        fileHash: hashFileBuffer(Buffer.from(`${TAG}-merge`)),
        periodStart: "2026-04-01",
        periodEnd: "2026-04-18",
        txnCount: 1,
      })
      .returning({ id: statementImports.id });

    const [targetRow] = await db
      .insert(transactions)
      .values({
        userId,
        accountId,
        occurredAt: targetDate,
        amountCents: BigInt(-25_573_00), // ← different amount (FX rounding)
        currency: "COP",
        descriptionRaw: `${TAG} bank-description`,
        source: "csv_reconcile",
        channel: "bank",
        statementImportId: imp.id,
        reconciliationStatus: "imported_from_statement",
      })
      .returning({ id: transactions.id });

    await recordReconciliationDecision({
      userId,
      txnId: flaggedRow.id,
      action: "merged_into",
      mergedIntoTxnId: targetRow.id,
      note: "FX rounding on intl txn",
    });

    // Flagged row survived, adopted statement amount/description, status=matched, kept category.
    const [survivor] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, flaggedRow.id));
    expect(survivor).toBeDefined();
    expect(survivor.amountCents).toBe(BigInt(-25_573_00));
    expect(survivor.descriptionRaw).toBe(`${TAG} bank-description`);
    expect(survivor.reconciliationStatus).toBe("matched");
    expect(survivor.statementImportId).toBe(imp.id);
    expect(survivor.categorySlug).toBe("mercado");

    // Target was deleted.
    const targetAfter = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, targetRow.id));
    expect(targetAfter).toHaveLength(0);

    // Decision row recorded. mergedIntoTxnId is now NULL because of ON DELETE SET NULL.
    const [decision] = await db
      .select()
      .from(reconciliationDecisions)
      .where(eq(reconciliationDecisions.txnId, flaggedRow.id));
    expect(decision.action).toBe("merged_into");
    expect(decision.mergedIntoTxnId).toBeNull();
    expect(decision.note).toBe("FX rounding on intl txn");
  });

  it("rejects merge when target is not imported_from_statement", async () => {
    const flagged = await createExistingTxn(userId, accountId, BigInt(-1000_00), new Date());
    await db
      .update(transactions)
      .set({ reconciliationStatus: "flagged" })
      .where(eq(transactions.id, flagged));

    const nonImported = await createExistingTxn(userId, accountId, BigInt(-1000_00), new Date());
    // default reconciliationStatus is 'unreconciled'

    await expect(
      recordReconciliationDecision({
        userId,
        txnId: flagged,
        action: "merged_into",
        mergedIntoTxnId: nonImported,
      }),
    ).rejects.toThrow(/merge_target_not_importable/);

    // Flagged row unchanged
    const [still] = await db.select().from(transactions).where(eq(transactions.id, flagged));
    expect(still.reconciliationStatus).toBe("flagged");
  });
});
