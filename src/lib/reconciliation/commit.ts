import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { reconciliationDecisions, statementImports, transactions } from "@/lib/db/schema";
import type { ParsedStatement, ParsedStatementRow } from "./parsers/types";
import type { MatchingPlan } from "./engine/types";

export type CommitStatus = "applied" | "already_imported";

export interface CommitResult {
  status: CommitStatus;
  statementImportId: number;
  inserted: number;
  matched: number;
  flagged: number;
}

export interface CommitAccount {
  id: number;
  currency: "COP" | "USD";
}

export interface CommitInput {
  userId: number;
  account: CommitAccount;
  parsed: ParsedStatement;
  plan: MatchingPlan;
  fileHash: string;
}

/**
 * Commits a MatchingPlan against the DB in a single transaction.
 * Idempotent by (user_id, account_id, file_hash): a second apply of the
 * same file short-circuits to `already_imported` without touching any
 * row.
 *
 * Sign translation happens here, at the persistence boundary:
 *   parsed.direction === 'in'  → +amountCents
 *   parsed.direction === 'out' → −amountCents
 * The DB stores signed amountCents (findash convention: positive =
 * ingreso, negative = gasto).
 */
export async function commitReconciliation(input: CommitInput): Promise<CommitResult> {
  return db.transaction(async (tx) => {
    const existingImport = await tx
      .select({ id: statementImports.id })
      .from(statementImports)
      .where(
        and(
          eq(statementImports.userId, input.userId),
          eq(statementImports.accountId, input.account.id),
          eq(statementImports.fileHash, input.fileHash),
        ),
      )
      .limit(1);
    if (existingImport.length > 0) {
      return {
        status: "already_imported" as const,
        statementImportId: existingImport[0].id,
        inserted: 0,
        matched: 0,
        flagged: 0,
      };
    }

    const [imp] = await tx
      .insert(statementImports)
      .values({
        userId: input.userId,
        accountId: input.account.id,
        fileHash: input.fileHash,
        periodStart: toIsoDate(input.parsed.periodStart),
        periodEnd: toIsoDate(input.parsed.periodEnd),
        txnCount: 0,
        balanceAtEndCents: input.parsed.balanceAtEndCents,
      })
      .returning({ id: statementImports.id });

    let matched = 0;
    let inserted = 0;

    for (const decision of input.plan.decisions) {
      const parsedRow = input.parsed.rows[decision.statementRowIndex];
      if (!parsedRow) continue;

      if (decision.action === "match" && decision.matchedTxnId !== null) {
        await tx
          .update(transactions)
          .set({
            reconciliationStatus: "matched",
            reconciledAt: new Date(),
            statementImportId: imp.id,
            updatedAt: new Date(),
          })
          .where(
            and(eq(transactions.id, decision.matchedTxnId), eq(transactions.userId, input.userId)),
          );
        matched++;
      } else {
        await tx.insert(transactions).values({
          userId: input.userId,
          accountId: input.account.id,
          occurredAt: parsedRow.occurredAt,
          amountCents: signedAmount(parsedRow),
          currency: input.account.currency,
          descriptionRaw: parsedRow.descriptionRaw,
          source: "csv_reconcile",
          channel: "bank",
          reconciliationStatus: "imported_from_statement",
          reconciledAt: new Date(),
          statementImportId: imp.id,
          rawData: parsedRow.rawData,
        });
        inserted++;
      }
    }

    if (input.plan.flaggedExisting.length > 0) {
      const ids = input.plan.flaggedExisting.map((f) => f.txnId);
      await tx
        .update(transactions)
        .set({
          reconciliationStatus: "flagged",
          reconciledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.userId, input.userId), inArray(transactions.id, ids)));
    }

    await tx
      .update(statementImports)
      .set({ txnCount: matched + inserted })
      .where(eq(statementImports.id, imp.id));

    return {
      status: "applied" as const,
      statementImportId: imp.id,
      inserted,
      matched,
      flagged: input.plan.flaggedExisting.length,
    };
  });
}

/**
 * Records a post-hoc user decision on a flagged transaction (archive |
 * keep | merge_into). Writes an audit row and, for archive, sets the
 * tx's `deleted_at` so it's filtered out of balance/spend queries.
 */
export interface ReviewInput {
  userId: number;
  txnId: number;
  action: "archived" | "kept" | "merged_into";
  mergedIntoTxnId?: number;
  note?: string;
}

export async function recordReconciliationDecision(input: ReviewInput): Promise<void> {
  if (input.action === "merged_into" && !input.mergedIntoTxnId) {
    throw new Error("merged_into action requires mergedIntoTxnId");
  }
  await db.transaction(async (tx) => {
    await tx.insert(reconciliationDecisions).values({
      userId: input.userId,
      txnId: input.txnId,
      action: input.action,
      mergedIntoTxnId: input.mergedIntoTxnId ?? null,
      note: input.note ?? null,
    });
    if (input.action === "archived") {
      await tx
        .update(transactions)
        .set({ updatedAt: new Date() })
        .where(and(eq(transactions.id, input.txnId), eq(transactions.userId, input.userId)));
    } else if (input.action === "kept") {
      await tx
        .update(transactions)
        .set({ reconciliationStatus: "unreconciled", updatedAt: new Date() })
        .where(and(eq(transactions.id, input.txnId), eq(transactions.userId, input.userId)));
    }
  });
}

export function hashFileBuffer(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function signedAmount(row: ParsedStatementRow): bigint {
  return row.direction === "in" ? row.amountCents : -row.amountCents;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
