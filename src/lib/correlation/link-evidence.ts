import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, transactions, type ParsedReceiptError } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { evidenceGatewayIds, type GatewayId } from "@/lib/gmail/registry";
import { EVIDENCE_TIME_ONLY_WINDOW_MS, timeOnlyEligible } from "@/lib/correlation/correlate";

const log = createLogger({ module: "correlation/link-evidence" });

export type EvidenceTxCandidate = {
  txId: number;
  deltaMs: number;
};

export type EvidenceLinkResult =
  | { status: "matched"; transactionId: number }
  | { status: "unmatched" }
  | { status: "abstained"; candidateIds: number[] };

export type EvidenceBackfillReport = {
  considered: number;
  matched: number;
  abstained: number;
  unmatched: number;
};

type LoadedEvidenceReceipt = {
  id: number;
  userId: number;
  gateway: GatewayId;
  amountCents: bigint | null;
  emailReceivedAt: Date | null;
  matchStatus: "pending" | "matched" | "ambiguous" | "unmatched";
  matchedTransactionId: number | null;
  parsedPayload: unknown;
};

function payloadHasError(payload: unknown): payload is ParsedReceiptError {
  return Boolean(payload && typeof payload === "object" && "error" in payload);
}

async function loadReceipt(userId: number, receiptId: number): Promise<LoadedEvidenceReceipt> {
  const [receipt] = await db
    .select({
      id: emailReceipts.id,
      userId: emailReceipts.userId,
      gateway: emailReceipts.gateway,
      amountCents: emailReceipts.amountCents,
      emailReceivedAt: emailReceipts.emailReceivedAt,
      matchStatus: emailReceipts.matchStatus,
      matchedTransactionId: emailReceipts.matchedTransactionId,
      parsedPayload: emailReceipts.parsedPayload,
    })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.id, receiptId),
        eq(emailReceipts.userId, userId),
        notDeleted(emailReceipts.deletedAt),
      ),
    );

  if (!receipt) {
    throw new Error(
      `[correlation/link-evidence] receipt ${receiptId} not found for user ${userId}`,
    );
  }

  return receipt;
}

async function candidatesForReceipt(
  receipt: LoadedEvidenceReceipt,
): Promise<EvidenceTxCandidate[]> {
  if (payloadHasError(receipt.parsedPayload)) return [];
  if (receipt.emailReceivedAt == null) return [];
  if (!timeOnlyEligible({ amountCents: receipt.amountCents, gateway: receipt.gateway })) {
    return [];
  }

  const receivedAt = receipt.emailReceivedAt;
  const windowStart = new Date(receivedAt.getTime() - EVIDENCE_TIME_ONLY_WINDOW_MS);
  const windowEnd = new Date(receivedAt.getTime() + EVIDENCE_TIME_ONLY_WINDOW_MS);

  const rows = await db
    .select({
      txId: transactions.id,
      occurredAt: transactions.occurredAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, receipt.userId),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        notDeleted(transactions.deletedAt),
      ),
    );

  const scored = rows.map((row) => ({
    txId: row.txId,
    deltaMs: row.occurredAt.getTime() - receivedAt.getTime(),
  }));
  scored.sort((a, b) => {
    const byTime = Math.abs(a.deltaMs) - Math.abs(b.deltaMs);
    if (byTime !== 0) return byTime;
    return a.txId - b.txId;
  });
  return scored;
}

/**
 * Receipt-first time-only correlator. Time is the only discriminator —
 * evidence receipts have no amount. Two candidates inside the window is
 * abstain, not nearest-neighbor (#857 / #863). Does not write.
 */
export async function findEvidenceTxCandidates(
  userId: number,
  receiptId: number,
): Promise<EvidenceTxCandidate[]> {
  const receipt = await loadReceipt(userId, receiptId);
  return candidatesForReceipt(receipt);
}

/**
 * Persist provenance on the receipt when exactly one in-window transaction
 * exists. Never updates the transaction row — category, method, confidence,
 * merchant, and classification_reason stay untouched. This adds a FK, not
 * authority.
 */
export async function linkEvidenceReceipt(
  userId: number,
  receiptId: number,
): Promise<EvidenceLinkResult> {
  const receipt = await loadReceipt(userId, receiptId);

  if (receipt.matchStatus === "matched" && receipt.matchedTransactionId != null) {
    return { status: "matched", transactionId: receipt.matchedTransactionId };
  }

  const candidates = await candidatesForReceipt(receipt);

  if (candidates.length === 0) {
    log.info(
      { userId, receiptId, event: "evidence_link_unmatched" },
      "no in-window transaction for evidence receipt",
    );
    return { status: "unmatched" };
  }

  if (candidates.length > 1) {
    const candidateIds = candidates.map((c) => c.txId);
    log.info(
      {
        userId,
        receiptId,
        candidateIds,
        candidateCount: candidates.length,
        event: "evidence_link_abstained",
      },
      "two or more in-window transactions; abstaining",
    );
    return { status: "abstained", candidateIds };
  }

  const transactionId = candidates[0]!.txId;

  await db
    .update(emailReceipts)
    .set({
      matchedTransactionId: transactionId,
      matchStatus: "matched",
      updatedAt: new Date(),
    })
    .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));

  log.info(
    {
      userId,
      receiptId,
      transactionId,
      deltaMs: candidates[0]!.deltaMs,
      event: "evidence_link_matched",
    },
    "linked evidence receipt to unique in-window transaction",
  );

  return { status: "matched", transactionId };
}

function unmatchedEvidenceWhere(userId?: number) {
  const evidenceIds = evidenceGatewayIds();
  const conditions = [
    inArray(emailReceipts.gateway, evidenceIds),
    eq(emailReceipts.matchStatus, "unmatched"),
    isNull(emailReceipts.matchedTransactionId),
    isNull(emailReceipts.amountCents),
    isNotNull(emailReceipts.emailReceivedAt),
    isNotNull(emailReceipts.parsedAt),
    sql`${emailReceipts.parsedPayload}->>'error' is null`,
    notDeleted(emailReceipts.deletedAt),
  ];
  if (userId !== undefined) conditions.push(eq(emailReceipts.userId, userId));
  return and(...conditions);
}

export async function countUnmatchedEvidenceReceipts(opts?: { userId?: number }): Promise<number> {
  if (evidenceGatewayIds().length === 0) return 0;
  const rows = await db
    .select({ id: emailReceipts.id })
    .from(emailReceipts)
    .where(unmatchedEvidenceWhere(opts?.userId));
  return rows.length;
}

/**
 * Correlate unmatched amount-less evidence receipts. Idempotent: matched
 * rows are outside the WHERE, and `linkEvidenceReceipt` no-ops when the
 * receipt is already matched.
 */
export async function backfillUnmatchedEvidenceReceipts(opts?: {
  userId?: number;
}): Promise<EvidenceBackfillReport> {
  const report: EvidenceBackfillReport = {
    considered: 0,
    matched: 0,
    abstained: 0,
    unmatched: 0,
  };

  if (evidenceGatewayIds().length === 0) return report;

  const rows = await db
    .select({ id: emailReceipts.id, userId: emailReceipts.userId })
    .from(emailReceipts)
    .where(unmatchedEvidenceWhere(opts?.userId));

  report.considered = rows.length;

  for (const row of rows) {
    const result = await linkEvidenceReceipt(row.userId, row.id);
    switch (result.status) {
      case "matched":
        report.matched += 1;
        break;
      case "abstained":
        report.abstained += 1;
        break;
      case "unmatched":
        report.unmatched += 1;
        break;
      default: {
        const _never: never = result;
        throw new Error(
          `[correlation/link-evidence] unhandled link status: ${JSON.stringify(_never)}`,
        );
      }
    }
  }

  log.info(
    { ...report, userId: opts?.userId ?? null, event: "evidence_link_backfill_done" },
    "backfilled unmatched evidence receipts",
  );

  return report;
}
