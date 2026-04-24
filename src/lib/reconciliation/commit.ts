import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { reconciliationDecisions, statementImports, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
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
  /**
   * Primary target. Rows whose `parsedRow.currency === account.currency`
   * insert into this account. Single-currency statements use this
   * exclusively and don't pass `siblingAccount`.
   */
  account: CommitAccount;
  /**
   * #444 — optional other-currency sibling for Mastercard Internacional
   * (plastic-level xlsx mixing COP + USD rows in one sheet). When provided,
   * rows whose `parsedRow.currency === siblingAccount.currency` insert into
   * `siblingAccount` (NOT `account`). Caller guarantees:
   *   - `account.currency !== siblingAccount.currency`
   *   - every `parsed.row.currency` ∈ { account.currency, siblingAccount.currency }
   *
   * Commit throws on violations. One `statement_imports` row is created per
   * sub-account so re-upload is idempotent per-side.
   */
  siblingAccount?: CommitAccount;
  parsed: ParsedStatement;
  plan: MatchingPlan;
  fileHash: string;
  /**
   * Optional user-provided closing balance. When present, overrides whatever
   * `parsed.balanceAtEndCents` held (parsers for most banks can't extract
   * this — see #302 / #304). Null = no balance captured for this import;
   * divergence stays blank on /admin/health.
   *
   * Ignored in multi-currency mode (TC movimientos don't carry a closing
   * balance; caller is expected to pass null when siblingAccount is set).
   */
  userBalanceAtEndCents?: bigint | null;
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
  // #444 — build a currency → account map covering the primary + optional
  // sibling. Validate once up-front so we fail before touching the DB if the
  // caller is inconsistent (sibling of same currency, row pointing at a
  // currency neither target covers, etc.).
  const accountsByCurrency: Partial<Record<"COP" | "USD", CommitAccount>> = {
    [input.account.currency]: input.account,
  };
  if (input.siblingAccount) {
    if (input.siblingAccount.currency === input.account.currency) {
      throw new Error(`sibling_same_currency:${input.account.currency}`);
    }
    if (input.siblingAccount.id === input.account.id) {
      throw new Error("sibling_same_account");
    }
    accountsByCurrency[input.siblingAccount.currency] = input.siblingAccount;
  }
  for (const row of input.parsed.rows) {
    if (!accountsByCurrency[row.currency]) {
      throw new Error(`missing_account_for_currency:${row.currency}`);
    }
  }

  return db.transaction(async (tx) => {
    // Idempotency check on the primary account — multi-currency commits run
    // in a single transaction, so if the primary-side import exists, the
    // sibling-side one was created atomically in the same retry's tx (or
    // both rolled back). Checking primary alone is sufficient.
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

    const multiCurrency = input.siblingAccount !== undefined;
    // `userBalanceAtEndCents` only makes sense for a single-account import
    // (savings closing balance). TC movimientos don't carry it, and in the
    // multi-currency case the file doesn't ship a per-side closing balance
    // anyway — force null on both sides to keep the statement_imports row
    // honest.
    const balanceAtEndCents = multiCurrency
      ? null
      : input.userBalanceAtEndCents !== undefined && input.userBalanceAtEndCents !== null
        ? input.userBalanceAtEndCents
        : input.parsed.balanceAtEndCents;

    // Insert one statement_imports row per target account. Bigint counts are
    // patched below once we know the per-import txn totals.
    const importIdByCurrency: Partial<Record<"COP" | "USD", number>> = {};
    for (const currency of Object.keys(accountsByCurrency) as Array<"COP" | "USD">) {
      const target = accountsByCurrency[currency]!;
      const [imp] = await tx
        .insert(statementImports)
        .values({
          userId: input.userId,
          accountId: target.id,
          fileHash: input.fileHash,
          periodStart: toIsoDate(input.parsed.periodStart),
          periodEnd: toIsoDate(input.parsed.periodEnd),
          txnCount: 0,
          // Only the primary target carries the user-supplied closing balance
          // in single-currency mode; the sibling (when present) never does.
          balanceAtEndCents: target.id === input.account.id ? balanceAtEndCents : null,
        })
        .returning({ id: statementImports.id });
      importIdByCurrency[currency] = imp.id;
    }

    let matched = 0;
    let inserted = 0;
    const txnCountByImport = new Map<number, number>();

    for (const decision of input.plan.decisions) {
      const parsedRow = input.parsed.rows[decision.statementRowIndex];
      if (!parsedRow) continue;
      const target = accountsByCurrency[parsedRow.currency]!;
      const importId = importIdByCurrency[parsedRow.currency]!;

      if (decision.action === "match" && decision.matchedTxnId !== null) {
        await tx
          .update(transactions)
          .set({
            reconciliationStatus: "matched",
            reconciledAt: new Date(),
            statementImportId: importId,
            updatedAt: new Date(),
          })
          .where(
            and(eq(transactions.id, decision.matchedTxnId), eq(transactions.userId, input.userId)),
          );
        matched++;
      } else {
        await tx.insert(transactions).values({
          userId: input.userId,
          accountId: target.id,
          occurredAt: parsedRow.occurredAt,
          amountCents: signedAmount(parsedRow),
          currency: parsedRow.currency,
          descriptionRaw: parsedRow.descriptionRaw,
          source: "csv_reconcile",
          channel: "bank",
          reconciliationStatus: "imported_from_statement",
          reconciledAt: new Date(),
          statementImportId: importId,
          rawData: parsedRow.rawData,
        });
        inserted++;
      }
      txnCountByImport.set(importId, (txnCountByImport.get(importId) ?? 0) + 1);
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

    // Patch per-import txn counts (update-per-import keeps the statement_imports
    // row's `txn_count` accurate even when rows split across siblings).
    for (const [importId, count] of txnCountByImport) {
      await tx
        .update(statementImports)
        .set({ txnCount: count })
        .where(eq(statementImports.id, importId));
    }

    return {
      status: "applied" as const,
      statementImportId: importIdByCurrency[input.account.currency]!,
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
    if (input.action === "merged_into") {
      const targetId = input.mergedIntoTxnId!;
      const [target] = await tx
        .select({
          id: transactions.id,
          occurredAt: transactions.occurredAt,
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          descriptionRaw: transactions.descriptionRaw,
          statementImportId: transactions.statementImportId,
          rawData: transactions.rawData,
          reconciliationStatus: transactions.reconciliationStatus,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.id, targetId),
            eq(transactions.userId, input.userId),
            notDeleted(transactions.deletedAt),
          ),
        )
        .limit(1);
      if (!target) throw new Error("merge_target_not_found");
      if (target.reconciliationStatus !== "imported_from_statement") {
        throw new Error("merge_target_not_importable");
      }

      // The flagged row survives (keeps category_slug / counterparty / notes
      // from prior classification) and adopts the bank-authoritative fields
      // from the statement-imported target.
      const updated = await tx
        .update(transactions)
        .set({
          occurredAt: target.occurredAt,
          amountCents: target.amountCents,
          currency: target.currency,
          descriptionRaw: target.descriptionRaw,
          statementImportId: target.statementImportId,
          rawData: target.rawData,
          reconciliationStatus: "matched",
          reconciledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.id, input.txnId), eq(transactions.userId, input.userId)))
        .returning({ id: transactions.id });
      if (updated.length === 0) throw new Error("flagged_txn_not_found");

      // Record the decision before deleting the target so the FK is populated.
      // mergedIntoTxnId has ON DELETE SET NULL — acceptable loss of detail on
      // the audit row in exchange for no duplicate txn in balance queries.
      await tx.insert(reconciliationDecisions).values({
        userId: input.userId,
        txnId: input.txnId,
        action: input.action,
        mergedIntoTxnId: targetId,
        note: input.note ?? null,
      });

      await tx
        .delete(transactions)
        .where(and(eq(transactions.id, targetId), eq(transactions.userId, input.userId)));
      return;
    }

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
