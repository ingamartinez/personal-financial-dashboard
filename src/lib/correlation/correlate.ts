import { and, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getFxRateAsOf } from "@/lib/fx/repo";
import { createLogger } from "@/lib/logger";
import { convertCents } from "@/lib/money";
import type { Currency } from "@/lib/types";
import { evidenceGatewayIds, isEvidenceGateway, type GatewayId } from "@/lib/gmail/registry";

const log = createLogger({ module: "correlation/correlate" });

/**
 * ARQ date-only `occurred_at` is midnight UTC (19:00 Bogota the previous
 * calendar day). Measured EMI pairs spanned 14 min … 16.7 h; 36 h covers
 * that and the ~29 h Bogota-date worst case without opening the live
 * matcher's 2-day window.
 */
export const CORRELATION_WINDOW_MS = 36 * 60 * 60 * 1000;

/**
 * Time-only matches are permitted only for amount-less evidence receipts.
 *
 * Two minutes, not the investigator's 7-day `search_mail` cap and not the
 * 36h amount-bearing window. Those jobs have an amount (or a human) as a
 * second discriminator; evidence receipts do not.
 *
 * Prod jetsmart→tx unique gaps are all under a minute (2–52s; receipt 2253
 * is 2s from tx 1443). Receipt 2220's decoy is 220s away — outside this
 * bound — so 2220 unique-matches tx 2627 rather than guessing between 40s
 * and 220s. Two candidates inside the window still abstain (#863 / #857).
 * Two minutes also covers minute-truncated bank timestamps without pairing
 * unrelated mail on a busy day.
 */
export const EVIDENCE_TIME_ONLY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Card FX vs official TRM on the four EMI pairs was 0.52–1.00% after
 * integer COP→USD conversion. 150 bps leaves headroom; the floor covers
 * sub-dollar noise that relative bps would round away.
 */
export const FX_MATCH_TOLERANCE_BPS = 150;
export const FX_MATCH_TOLERANCE_FLOOR_CENTS = BigInt(50);

export const BOGOTA_TZ = "America/Bogota";

export type ExactAmountReason = {
  kind: "exact_amount";
  deltaCents: bigint;
  deltaMs: number;
};

export type CrossCurrencyReason = {
  kind: "cross_currency";
  rateAsOf: string;
  rate: number;
  deltaCents: bigint;
  deltaMs: number;
};

export type TimeOnlyReason = {
  kind: "time_only";
  deltaMs: number;
};

export type CorrelationReason = ExactAmountReason | CrossCurrencyReason | TimeOnlyReason;

export function isDeterministicReason(reason: CorrelationReason): boolean {
  switch (reason.kind) {
    case "exact_amount":
    case "cross_currency":
      return true;
    case "time_only":
      return false;
    default: {
      const _never: never = reason;
      throw new Error(`[correlation] unhandled reason kind: ${JSON.stringify(_never)}`);
    }
  }
}

export function timeOnlyEligible(receipt: {
  amountCents: bigint | null;
  gateway: GatewayId;
}): boolean {
  if (receipt.amountCents != null) return false;
  return isEvidenceGateway(receipt.gateway);
}

function kindRank(kind: CorrelationReason["kind"]): number {
  switch (kind) {
    case "exact_amount":
      return 0;
    case "cross_currency":
      return 1;
    case "time_only":
      return 2;
    default: {
      const _never: never = kind;
      throw new Error(`[correlation] unhandled reason kind: ${String(_never)}`);
    }
  }
}

export type RankedCandidate = {
  receiptId: number;
  rank: number;
  reason: CorrelationReason;
};

export type CorrelateResult = {
  candidates: RankedCandidate[];
};

export function bogotaCalendarDay(instant: Date): string {
  return instant.toLocaleDateString("en-CA", { timeZone: BOGOTA_TZ });
}

export function fxToleranceCents(txAbsCents: bigint): bigint {
  const relative = (txAbsCents * BigInt(FX_MATCH_TOLERANCE_BPS)) / BigInt(10_000);
  return relative > FX_MATCH_TOLERANCE_FLOOR_CENTS ? relative : FX_MATCH_TOLERANCE_FLOOR_CENTS;
}

function absCents(n: bigint): bigint {
  return n < BigInt(0) ? -n : n;
}

/**
 * Tx-first temporal correlator. Always returns a ranked candidate set with
 * a reason per row — a unique exact match is still a one-element set, never
 * a silent `{ status: "matched" }`. Does not write receipts or transactions.
 *
 * Receipts with NULL `email_received_at` are skipped. `createdAt` is ingest
 * time (pre-#545 rows) and must not be used as event time.
 */
export async function correlateTransaction(
  userId: number,
  transactionId: number,
): Promise<CorrelateResult> {
  const [tx] = await db
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      occurredAt: transactions.occurredAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.id, transactionId),
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
      ),
    );

  if (!tx) {
    throw new Error(
      `[correlation/correlate] transaction ${transactionId} not found for user ${userId}`,
    );
  }

  const windowStart = new Date(tx.occurredAt.getTime() - CORRELATION_WINDOW_MS);
  const windowEnd = new Date(tx.occurredAt.getTime() + CORRELATION_WINDOW_MS);
  const txAbs = absCents(tx.amountCents);
  const txCurrency = tx.currency as Currency;

  const receipts = await db
    .select({
      id: emailReceipts.id,
      amountCents: emailReceipts.amountCents,
      currency: emailReceipts.currency,
      emailReceivedAt: emailReceipts.emailReceivedAt,
    })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        isNotNull(emailReceipts.emailReceivedAt),
        isNotNull(emailReceipts.amountCents),
        isNotNull(emailReceipts.currency),
        gte(emailReceipts.emailReceivedAt, windowStart),
        lte(emailReceipts.emailReceivedAt, windowEnd),
        notDeleted(emailReceipts.deletedAt),
      ),
    );

  let fxRate: Awaited<ReturnType<typeof getFxRateAsOf>> | undefined;
  const scored: Array<{ receiptId: number; reason: CorrelationReason }> = [];

  for (const receipt of receipts) {
    if (
      receipt.amountCents == null ||
      receipt.currency == null ||
      receipt.emailReceivedAt == null
    ) {
      continue;
    }
    const receiptAbs = absCents(receipt.amountCents);
    const receiptCurrency = receipt.currency as Currency;
    const deltaMs = receipt.emailReceivedAt.getTime() - tx.occurredAt.getTime();

    if (receiptCurrency === txCurrency) {
      if (receiptAbs === txAbs) {
        scored.push({
          receiptId: receipt.id,
          reason: { kind: "exact_amount", deltaCents: BigInt(0), deltaMs },
        });
      }
      continue;
    }

    if (fxRate === undefined) {
      fxRate = await getFxRateAsOf(bogotaCalendarDay(tx.occurredAt));
    }
    if (!fxRate) {
      continue;
    }

    const converted = convertCents(receiptAbs, receiptCurrency, txCurrency, fxRate.rate);
    const deltaCents = absCents(converted - txAbs);
    if (deltaCents > fxToleranceCents(txAbs)) continue;

    scored.push({
      receiptId: receipt.id,
      reason: {
        kind: "cross_currency",
        rateAsOf: fxRate.asOf,
        rate: fxRate.rate,
        deltaCents,
        deltaMs,
      },
    });
  }

  const evidenceIds = evidenceGatewayIds();
  if (evidenceIds.length > 0) {
    const timeOnlyStart = new Date(tx.occurredAt.getTime() - EVIDENCE_TIME_ONLY_WINDOW_MS);
    const timeOnlyEnd = new Date(tx.occurredAt.getTime() + EVIDENCE_TIME_ONLY_WINDOW_MS);
    const evidenceReceipts = await db
      .select({
        id: emailReceipts.id,
        amountCents: emailReceipts.amountCents,
        emailReceivedAt: emailReceipts.emailReceivedAt,
        gateway: emailReceipts.gateway,
      })
      .from(emailReceipts)
      .where(
        and(
          eq(emailReceipts.userId, userId),
          inArray(emailReceipts.gateway, evidenceIds),
          isNotNull(emailReceipts.emailReceivedAt),
          isNull(emailReceipts.amountCents),
          gte(emailReceipts.emailReceivedAt, timeOnlyStart),
          lte(emailReceipts.emailReceivedAt, timeOnlyEnd),
          notDeleted(emailReceipts.deletedAt),
        ),
      );

    for (const receipt of evidenceReceipts) {
      if (receipt.emailReceivedAt == null) continue;
      if (!timeOnlyEligible({ amountCents: receipt.amountCents, gateway: receipt.gateway })) {
        throw new Error(
          `[correlation/correlate] time-only query returned a non-eligible receipt ${receipt.id}`,
        );
      }
      scored.push({
        receiptId: receipt.id,
        reason: {
          kind: "time_only",
          deltaMs: receipt.emailReceivedAt.getTime() - tx.occurredAt.getTime(),
        },
      });
    }
  }

  scored.sort((a, b) => {
    const byKind = kindRank(a.reason.kind) - kindRank(b.reason.kind);
    if (byKind !== 0) return byKind;
    const aCents = a.reason.kind === "time_only" ? null : a.reason.deltaCents;
    const bCents = b.reason.kind === "time_only" ? null : b.reason.deltaCents;
    if (aCents != null && bCents != null && aCents !== bCents) {
      return aCents < bCents ? -1 : 1;
    }
    const byTime = Math.abs(a.reason.deltaMs) - Math.abs(b.reason.deltaMs);
    if (byTime !== 0) return byTime;
    return a.receiptId - b.receiptId;
  });

  const candidates: RankedCandidate[] = scored.map((row, index) => ({
    receiptId: row.receiptId,
    rank: index + 1,
    reason: row.reason,
  }));

  log.info(
    {
      userId,
      transactionId,
      candidateCount: candidates.length,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      event: "correlate_candidates",
    },
    "correlated receipts for transaction",
  );

  return { candidates };
}
