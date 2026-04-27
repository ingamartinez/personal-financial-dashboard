import type { ParsedStatementRow } from "../parsers/types";
import type { ExistingTxnForMatch, MatchDecision, MatchingInput, MatchingPlan } from "./types";

export const DEFAULT_DATE_TOLERANCE_DAYS = 3;
const DEFAULT_MERCHANT_FUZZ_THRESHOLD = 0.5;
const MS_PER_DAY = 86_400_000;

// Near-match defaults. Tightened vs exact match: amount differs, so we need
// stronger date + description signal to confidently propose a merge.
const NEAR_MATCH_DEFAULTS = {
  dateToleranceDays: 2,
  // Overlap-coefficient threshold. 0.5 means at least half of the smaller
  // set must be in the larger — strict enough that pairs need real shared
  // content, lenient enough to ignore bank prefix noise.
  descriptionSimilarityMin: 0.5,
  // Minimum tokens in the SMALLER description after tokenize(). Below this
  // the similarity signal is too noisy (a 1-token SMS scores 1.0 against
  // anything containing that token).
  minTokensInSmallerSet: 2,
  // $500 COP — smaller than this is noise; also the Bancolombia statement
  // FX-rounding amounts we've seen in real data (1–125 pesos) fit under it.
  amountFloorCopCents: BigInt(500_00),
  // $0.05 USD — same spirit as COP floor at a sensible scale.
  amountFloorUsdCents: BigInt(5),
  // 1% — scales the floor for larger transactions where absolute rounding
  // noise is proportional.
  amountPercentTolerance: 0.01,
};

export function matchStatement(input: MatchingInput): MatchingPlan {
  const dateToleranceDays = input.config?.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS;
  const merchantFuzzThreshold =
    input.config?.merchantFuzzThreshold ?? DEFAULT_MERCHANT_FUZZ_THRESHOLD;
  const toleranceMs = dateToleranceDays * MS_PER_DAY;

  const eligibleExisting = input.existingTxns.filter(
    (e) => e.channel !== "manual" && !e.isAdjustment,
  );
  const consumed = new Set<number>();
  const decisions: MatchDecision[] = [];

  for (let i = 0; i < input.parsedRows.length; i++) {
    const parsed = input.parsedRows[i];
    const parsedSignedCents = parsed.direction === "in" ? parsed.amountCents : -parsed.amountCents;
    const parsedTokens = tokenize(parsed.descriptionRaw);

    let best: { txnId: number; score: number; reason: MatchDecision["matchReason"] } | null = null;

    for (const candidate of eligibleExisting) {
      if (consumed.has(candidate.id)) continue;
      if (candidate.currency !== parsed.currency) continue;
      if (candidate.amountCents !== parsedSignedCents) continue;

      const deltaMs = Math.abs(candidate.occurredAt.getTime() - parsed.occurredAt.getTime());
      if (deltaMs > toleranceMs) continue;

      const candidateTokens = tokenize(`${candidate.descriptionRaw} ${candidate.merchant ?? ""}`);
      const similarity = jaccard(parsedTokens, candidateTokens);
      const reason: MatchDecision["matchReason"] =
        similarity >= merchantFuzzThreshold ? "amount_date_fuzzy_merchant" : "amount_date_exact";
      const score = scoreMatch(deltaMs, similarity);

      if (!best || score > best.score) {
        best = { txnId: candidate.id, score, reason };
      }
    }

    if (best) {
      consumed.add(best.txnId);
      decisions.push({
        statementRowIndex: i,
        action: "match",
        matchedTxnId: best.txnId,
        matchScore: best.score,
        matchReason: best.reason,
      });
    } else {
      decisions.push({
        statementRowIndex: i,
        action: "insert_new",
        matchedTxnId: null,
        matchScore: 0,
        matchReason: "no_match",
      });
    }
  }

  // Second pass: for each insert_new decision, look for a near-match among
  // the remaining unmatched candidates. Near-match is a UI hint — the
  // candidate is NOT consumed, so it still flows to flaggedExisting and the
  // user merges post-Apply via the picker from #301.
  const nearMatchCfg = { ...NEAR_MATCH_DEFAULTS, ...(input.config?.nearMatch ?? {}) };
  const nearDateToleranceMs = nearMatchCfg.dateToleranceDays * MS_PER_DAY;

  for (let i = 0; i < decisions.length; i++) {
    const decision = decisions[i];
    if (decision.action !== "insert_new") continue;

    const parsed = input.parsedRows[decision.statementRowIndex];
    const parsedSignedCents = parsed.direction === "in" ? parsed.amountCents : -parsed.amountCents;
    const parsedTokens = tokenize(parsed.descriptionRaw);

    let best: {
      txnId: number;
      score: number;
      amountDiffCents: bigint;
      dateDiffDays: number;
      similarity: number;
    } | null = null;

    for (const candidate of eligibleExisting) {
      if (consumed.has(candidate.id)) continue;
      if (candidate.currency !== parsed.currency) continue;
      // Same sign — a debit and a credit of similar magnitude is not a merge.
      if (sameSign(candidate.amountCents, parsedSignedCents) === false) continue;

      const amountDiff = absBigInt(candidate.amountCents - parsedSignedCents);
      if (amountDiff === BigInt(0)) continue; // exact match would have caught this

      const amountThreshold = nearMatchAmountThreshold(
        absBigInt(candidate.amountCents),
        candidate.currency,
        nearMatchCfg,
      );
      if (amountDiff > amountThreshold) continue;

      const deltaMs = Math.abs(candidate.occurredAt.getTime() - parsed.occurredAt.getTime());
      if (deltaMs > nearDateToleranceMs) continue;

      const candidateTokens = tokenize(`${candidate.descriptionRaw} ${candidate.merchant ?? ""}`);
      // Overlap coefficient (not jaccard) to ignore the asymmetry between
      // bank-feed descriptions (long, with prefixes like "COMPRA INTL")
      // vs SMS-captured descriptions (short, merchant-focused). Guard
      // against tiny sets: a 1-token SMS like `{pago}` would score 1.0
      // against any description containing "pago".
      const smallerSetSize = Math.min(parsedTokens.size, candidateTokens.size);
      if (smallerSetSize < nearMatchCfg.minTokensInSmallerSet) continue;
      const similarity = overlapCoefficient(parsedTokens, candidateTokens);
      if (similarity < nearMatchCfg.descriptionSimilarityMin) continue;

      const score = scoreMatch(deltaMs, similarity);
      if (!best || score > best.score) {
        best = {
          txnId: candidate.id,
          score,
          amountDiffCents: amountDiff,
          dateDiffDays: Math.round(deltaMs / MS_PER_DAY),
          similarity,
        };
      }
    }

    if (best) {
      decisions[i] = {
        ...decision,
        action: "near_match",
        matchedTxnId: best.txnId,
        matchScore: best.score,
        matchReason: "near_match_fuzzy_amount",
        amountDiffCents: best.amountDiffCents.toString(),
        dateDiffDays: best.dateDiffDays,
        descriptionSimilarity: best.similarity,
      };
    }
  }

  const periodStartMs = input.period?.start.getTime();
  const periodEndMs = input.period?.end.getTime();
  const flaggedExisting = eligibleExisting
    .filter((e) => !consumed.has(e.id) && e.reconciliationStatus === "unreconciled")
    .filter((e) => {
      if (periodStartMs === undefined || periodEndMs === undefined) return true;
      const ms = e.occurredAt.getTime();
      return ms >= periodStartMs && ms <= periodEndMs;
    })
    .map((e) => ({ txnId: e.id, reason: "no_statement_match" as const }));

  const matched = decisions.filter((d) => d.action === "match").length;
  const nearMatches = decisions.filter((d) => d.action === "near_match").length;
  const newInserts = decisions.length - matched - nearMatches;

  return {
    decisions,
    flaggedExisting,
    summary: {
      matched,
      newInserts,
      nearMatches,
      flaggedExisting: flaggedExisting.length,
    },
  };
}

const ZERO = BigInt(0);

function absBigInt(v: bigint): bigint {
  return v < ZERO ? -v : v;
}

function sameSign(a: bigint, b: bigint): boolean {
  if (a === ZERO || b === ZERO) return a === b;
  return a < ZERO === b < ZERO;
}

function nearMatchAmountThreshold(
  absAmountCents: bigint,
  currency: "COP" | "USD",
  cfg: typeof NEAR_MATCH_DEFAULTS,
): bigint {
  const floor = currency === "USD" ? cfg.amountFloorUsdCents : cfg.amountFloorCopCents;
  // BigInt × fractional percent via integer arithmetic: multiply by basis points
  // (percent × 10_000) then divide back, staying in bigint land.
  const basisPoints = BigInt(Math.round(cfg.amountPercentTolerance * 10_000));
  const percentBased = (absAmountCents * basisPoints) / BigInt(10_000);
  return percentBased > floor ? percentBased : floor;
}

/**
 * Score in [0, 100]: date proximity dominates (up to 50), merchant
 * similarity fills the rest (up to 50). Same-day gets the full 50;
 * each additional day drops 10 points until 0.
 */
function scoreMatch(deltaMs: number, similarity: number): number {
  const deltaDays = Math.round(deltaMs / MS_PER_DAY);
  const dateScore = Math.max(0, 50 - deltaDays * 10);
  const merchantScore = Math.round(similarity * 50);
  return Math.min(100, dateScore + merchantScore);
}

export function tokenize(input: string): Set<string> {
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ");
  const out = new Set<string>();
  for (const token of cleaned.split(/\s+/)) {
    if (token.length >= 3) out.add(token);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersectionSize = 0;
  for (const t of a) if (b.has(t)) intersectionSize++;
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Overlap (Szymkiewicz–Simpson) coefficient: |A ∩ B| / min(|A|, |B|).
 *
 * Unlike jaccard, this ignores size asymmetry — ideal for comparing a short
 * SMS description against a longer bank-feed description where the bank
 * systematically prefixes extra tokens ("COMPRA INTL", "PAGO SUC VIRT").
 * Near-match uses this instead of jaccard so bank prefix noise doesn't
 * suppress legitimate merges.
 *
 * Callers can combine with a minimum-tokens guard on the smaller set to
 * avoid 1-token SMS like `{pago}` scoring 1.0 against everything.
 */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersectionSize = 0;
  for (const t of a) if (b.has(t)) intersectionSize++;
  const smaller = Math.min(a.size, b.size);
  return intersectionSize / smaller;
}

export type { ParsedStatementRow, ExistingTxnForMatch };
