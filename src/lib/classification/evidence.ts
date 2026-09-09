import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  emailReceipts,
  type ClassificationReasonJson,
  type ParsedReceiptError,
  type ParsedReceiptPayload,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { correlateTransaction, type RankedCandidate } from "@/lib/correlation/correlate";
import { matchOpaqueGateway, type OpaqueGateway } from "./opaque-gateways";
import type { AiClassifiable, AiReceiptEvidence } from "./ai";
import type { ClassifiableTx } from "./rules";

export type EvidenceReceipt = {
  id: number;
  gateway: string;
  merchant: string | null;
  amountCents: bigint | null;
  currency: string | null;
  referenceId: string | null;
  extra?: Record<string, unknown>;
};

export type TxEvidence = {
  candidates: RankedCandidate[];
  receipts: Map<number, EvidenceReceipt>;
  unique: boolean;
  opaque: OpaqueGateway | null;
};

function extraFromPayload(
  payload: ParsedReceiptPayload | ParsedReceiptError | Record<string, never> | null | undefined,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if ("error" in payload) return undefined;
  const extra = "extra" in payload ? payload.extra : undefined;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return undefined;
  return extra;
}

export async function loadReceiptsById(
  userId: number,
  receiptIds: number[],
): Promise<Map<number, EvidenceReceipt>> {
  const out = new Map<number, EvidenceReceipt>();
  if (receiptIds.length === 0) return out;
  const rows = await db
    .select({
      id: emailReceipts.id,
      gateway: emailReceipts.gateway,
      merchant: emailReceipts.merchant,
      amountCents: emailReceipts.amountCents,
      currency: emailReceipts.currency,
      referenceId: emailReceipts.referenceId,
      parsedPayload: emailReceipts.parsedPayload,
    })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        inArray(emailReceipts.id, receiptIds),
        notDeleted(emailReceipts.deletedAt),
      ),
    );
  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      gateway: row.gateway,
      merchant: row.merchant,
      amountCents: row.amountCents,
      currency: row.currency,
      referenceId: row.referenceId,
      extra: extraFromPayload(row.parsedPayload),
    });
  }
  return out;
}

export async function loadTxEvidence(
  userId: number,
  tx: {
    id: number;
    descriptionRaw: string;
    merchant?: string | null;
  },
): Promise<TxEvidence> {
  const { candidates } = await correlateTransaction(userId, tx.id);
  const receipts = await loadReceiptsById(
    userId,
    candidates.map((c) => c.receiptId),
  );
  return {
    candidates,
    receipts,
    unique: candidates.length === 1,
    opaque: matchOpaqueGateway([tx.descriptionRaw, tx.merchant]),
  };
}

export function uniqueReceipt(evidence: TxEvidence): EvidenceReceipt | null {
  if (!evidence.unique) return null;
  const id = evidence.candidates[0]?.receiptId;
  if (id == null) return null;
  return evidence.receipts.get(id) ?? null;
}

/**
 * Haystack for the rule engine. Opaque bank strings are not a merchant —
 * using them would let `%MERCADOPAGO%` (or prior-art on that string) poison
 * every later charge. Unique correlation keys on receipt.merchant instead.
 */
export function classifiableForRules(
  tx: {
    descriptionRaw: string;
    descriptionClean?: string | null;
    merchant?: string | null;
  },
  evidence: TxEvidence,
): ClassifiableTx {
  if (evidence.opaque) {
    const receipt = uniqueReceipt(evidence);
    const merchant = receipt?.merchant ?? null;
    return {
      descriptionRaw: merchant ?? "",
      descriptionClean: null,
      merchant,
    };
  }
  return {
    descriptionRaw: tx.descriptionRaw,
    descriptionClean: tx.descriptionClean,
    merchant: tx.merchant,
  };
}

export function priorArtLookupRow(
  tx: {
    canonicalMerchant: string | null;
    merchant: string | null;
    descriptionRaw: string;
  },
  evidence: TxEvidence,
): {
  canonicalMerchant: string | null;
  merchant: string | null;
  descriptionRaw: string;
} {
  if (evidence.opaque) {
    const merchant = uniqueReceipt(evidence)?.merchant ?? null;
    return {
      canonicalMerchant: null,
      merchant,
      descriptionRaw: merchant ?? "",
    };
  }
  return tx;
}

export function toAiEvidence(evidence: TxEvidence): AiReceiptEvidence[] {
  const out: AiReceiptEvidence[] = [];
  for (const candidate of evidence.candidates) {
    const receipt = evidence.receipts.get(candidate.receiptId);
    if (!receipt) continue;
    const row: AiReceiptEvidence = {
      receiptId: receipt.id,
      gateway: receipt.gateway,
      merchant: receipt.merchant,
      amountCents: receipt.amountCents == null ? null : receipt.amountCents.toString(),
      currency: receipt.currency,
      referenceId: receipt.referenceId,
      matchKind: candidate.reason.kind,
      deltaCents: candidate.reason.deltaCents.toString(),
      deltaMs: candidate.reason.deltaMs,
      rank: candidate.rank,
    };
    if (receipt.extra) row.extra = receipt.extra;
    if (candidate.reason.kind === "cross_currency") {
      row.rateAsOf = candidate.reason.rateAsOf;
      row.rate = candidate.reason.rate;
    }
    out.push(row);
  }
  return out;
}

export function toAiClassifiable(
  tx: {
    id: number;
    descriptionRaw: string;
    descriptionClean?: string | null;
    merchant?: string | null;
    amountCents: bigint;
    currency: "COP" | "USD";
  },
  evidence: TxEvidence,
): AiClassifiable {
  const bundle = toAiEvidence(evidence);
  return {
    id: tx.id,
    description: tx.descriptionClean ?? tx.merchant ?? tx.descriptionRaw,
    amountCents: tx.amountCents,
    currency: tx.currency,
    evidence: bundle.length > 0 ? bundle : undefined,
  };
}

export function citationFromEvidence(
  evidence: TxEvidence,
  extra: ClassificationReasonJson = {},
): ClassificationReasonJson {
  if (evidence.unique) {
    const candidate = evidence.candidates[0]!;
    return {
      ...extra,
      receiptId: candidate.receiptId,
      matchKind: candidate.reason.kind,
    };
  }
  if (evidence.candidates.length > 1) {
    return {
      ...extra,
      receiptIds: evidence.candidates.map((c) => c.receiptId),
      matchKind: evidence.candidates[0]!.reason.kind,
    };
  }
  return extra;
}
