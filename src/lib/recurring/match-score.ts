// #804: Pure scoring engine for auto-link candidates — combines the
// description-fingerprint token (from observation-recorder.ts) with the
// transaction amount to disambiguate which recurring a transaction belongs
// to. No DB access here — callers query candidates and call these functions.
//
// Design rationale (see issue #804 comment for the full prod-data writeup):
//   - `tokeniseDescription` alone is not enough: real prod data shows both
//     "token collides, amount separates" (APPLE.COM/BILL → Apple iCloud vs
//     Apple TV) AND "amount collides, token separates" (four recurrings at
//     exactly -4490000 COP, four distinct tokens). Neither signal alone
//     resolves this user's data; together they resolve all of it.
//   - A token that is extractable but matches NO candidate must NEVER fall
//     back to amount-only matching, even if the amount happens to uniquely
//     identify one candidate right now. Verified prod counter-examples:
//     `KFC UNICENTRO MEDELL` at -2990000 is byte-identical to the Apple TV
//     recurring's amount; `SPORTY CITY SAS7888` / a bank transfer are both
//     byte-identical to SmartFit's amount. Amount-only matching is only
//     acceptable when the token is absent/unknown (not merely unmatched).
//   - Same-account is a ranking bonus (tie-breaker), never a hard predicate.

import {
  isGenericDescriptionToken,
  tokeniseDescription,
} from "@/lib/recurring/observation-recorder";
import type { Currency } from "@/lib/types";

export type MatchReason = "token" | "token+amount-exact" | "token+amount-nearest" | "amount-only";

export type MatchTx = {
  descriptionRaw: string | null | undefined;
  amountCents: bigint;
  currency: Currency;
  accountId: number;
  occurredAt?: Date;
};

export type MatchCandidate = {
  recurringId: number;
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  /** Union of ALL learned description-fingerprint patterns for this recurring. */
  patterns: string[];
};

export type ScoredCandidate = {
  recurringId: number;
  reason: MatchReason;
  sameAccount: boolean;
};

export type MatchScoreResult = {
  /** The single winning candidate, or null when ambiguous / no signal. */
  winner: ScoredCandidate | null;
  /** True when 2+ candidates tied and could not be disambiguated further. */
  ambiguous: boolean;
};

const NO_MATCH: MatchScoreResult = { winner: null, ambiguous: false };

function isSameAmount(
  a: { amountCents: bigint; currency: Currency },
  b: { amountCents: bigint; currency: Currency },
): boolean {
  return a.currency === b.currency && a.amountCents === b.amountCents;
}

function amountDistance(a: bigint, b: bigint): bigint {
  const d = a - b;
  return d < BigInt(0) ? -d : d;
}

function absCents(n: bigint): bigint {
  return n < BigInt(0) ? -n : n;
}

/**
 * #857: Bounded leftover-amount tolerance, as a fraction of the recurring's
 * own amount — never an absolute peso figure.
 *
 * 100 bps = 1%. Why 1% and not 0.5 / 2 / a COP constant:
 *   - Prod Aida July (#857) drifted 0.40% (200_000 cents on 49_910_000).
 *     1% leaves ~2.5× headroom for a slightly larger IBC / late-interest
 *     tweak without treating it as a different obligation.
 *   - Twin spacing is NOT the safety invariant. 1.84% is this user's two
 *     rows, not a model property: twins 0.5% apart put a 0.40% drift inside
 *     both 1% balls. The guarantee is abstain-on-degree>=2 (inTolerance
 *     length >= 2 here; txDegree >= 2 + blockedTxIds in gap-detector).
 *     Bumping the fraction to "cover more drift" does not turn overlap
 *     into a nearest-guess — overlap still abstains.
 *   - #852 EPM swings tens of percent; 1% cannot swallow them. Opposite fix.
 *   - Price-hike detection fires at 15%. Orthogonal.
 *   - Existing unbounded token+amount-nearest cases (Google Play ~9%,
 *     Apple ~17%) have ZERO candidates inside 1%, so they keep that path.
 *
 * Inclusive at exactly 1.00%. Different currencies never match. A zero
 * recurring amount only matches a zero transaction (no division by zero).
 */
export const AMOUNT_TOLERANCE_BPS = BigInt(100);

export function isWithinAmountTolerance(
  recurringAmountCents: bigint,
  txAmountCents: bigint,
  recurringCurrency: Currency,
  txCurrency: Currency,
): boolean {
  if (recurringCurrency !== txCurrency) return false;
  const rec = absCents(recurringAmountCents);
  if (rec === BigInt(0)) return txAmountCents === BigInt(0);
  const dist = amountDistance(recurringAmountCents, txAmountCents);
  return dist * BigInt(10000) <= rec * AMOUNT_TOLERANCE_BPS;
}

/**
 * Narrow a tied pool of candidates by same-account bonus. Returns the single
 * winner if exactly one candidate shares the tx's account; otherwise null
 * (still ambiguous).
 */
function breakTieByAccount(pool: MatchCandidate[], tx: MatchTx): MatchCandidate | null {
  const sameAccountPool = pool.filter((c) => c.accountId === tx.accountId);
  return sameAccountPool.length === 1 ? sameAccountPool[0]! : null;
}

/**
 * Score a set of candidate recurrings against one incoming transaction and
 * return the winner (if unambiguous) with an explicit reason. Pure function —
 * no DB access. Callers are responsible for pre-filtering candidates to
 * whatever scope makes sense (e.g. active, non-deleted, date-window-eligible).
 */
export function scoreMatchCandidates(tx: MatchTx, candidates: MatchCandidate[]): MatchScoreResult {
  if (candidates.length === 0) return NO_MATCH;

  const token = tokeniseDescription(tx.descriptionRaw);

  if (token === null) {
    // No usable token — amount-only fallback, but ONLY when it uniquely
    // identifies a single candidate. Two+ candidates sharing the amount is a
    // genuine collision (e.g. a one-off purchase byte-identical to a
    // recurring's amount) and must not be silently guessed.
    const exact = candidates.filter((c) => isSameAmount(c, tx));
    if (exact.length === 1) {
      return {
        winner: {
          recurringId: exact[0]!.recurringId,
          reason: "amount-only",
          sameAccount: exact[0]!.accountId === tx.accountId,
        },
        ambiguous: false,
      };
    }
    return { winner: null, ambiguous: exact.length >= 2 };
  }

  const tokenMatches = candidates.filter((c) => c.patterns.includes(token));

  if (tokenMatches.length === 0) {
    // Token is extractable but matches nothing we've learned. Per the
    // KFC/SmartFit prod counter-examples, this BLOCKS amount-only fallback
    // entirely — an extractable-but-unmatched token means "this description
    // doesn't look like anything we know", regardless of amount collisions.
    return NO_MATCH;
  }

  if (tokenMatches.length === 1) {
    const c = tokenMatches[0]!;
    if (isGenericDescriptionToken(token) && !isSameAmount(c, tx)) return NO_MATCH;
    return {
      winner: {
        recurringId: c.recurringId,
        reason: "token",
        sameAccount: c.accountId === tx.accountId,
      },
      ambiguous: false,
    };
  }

  // Token collides across 2+ recurrings — narrow by amount (exact, then
  // nearest), then by same-account as a final tie-breaker.
  const exact = tokenMatches.filter((c) => isSameAmount(c, tx));

  if (exact.length === 1) {
    const c = exact[0]!;
    return {
      winner: {
        recurringId: c.recurringId,
        reason: "token+amount-exact",
        sameAccount: c.accountId === tx.accountId,
      },
      ambiguous: false,
    };
  }

  if (exact.length >= 2) {
    const winner = breakTieByAccount(exact, tx);
    if (winner) {
      return {
        winner: {
          recurringId: winner.recurringId,
          reason: "token+amount-exact",
          sameAccount: true,
        },
        ambiguous: false,
      };
    }
    return { winner: null, ambiguous: true };
  }

  if (isGenericDescriptionToken(token)) return NO_MATCH;

  // No exact amount among token matches. #857: a unique candidate inside
  // 1% of the recurring's amount is an unambiguous leftover — take it.
  // Two or more inside 1% is genuine ambiguity: abstain. A tolerance that
  // guesses is worse than no tolerance (wrong link is silent; a missing
  // link is visible). Zero inside 1% falls through to unbounded nearest
  // (Google Play ~9%, Apple ~17% — those stay as they were).
  const sameCurrency = tokenMatches.filter((c) => c.currency === tx.currency);
  if (sameCurrency.length === 0) {
    // Token collided but none of the colliding candidates share a currency
    // with the tx — no amount signal available to disambiguate.
    return { winner: null, ambiguous: true };
  }

  const inTolerance = sameCurrency.filter((c) =>
    isWithinAmountTolerance(c.amountCents, tx.amountCents, c.currency, tx.currency),
  );
  if (inTolerance.length === 1) {
    const c = inTolerance[0]!;
    return {
      winner: {
        recurringId: c.recurringId,
        reason: "token+amount-nearest",
        sameAccount: c.accountId === tx.accountId,
      },
      ambiguous: false,
    };
  }
  if (inTolerance.length >= 2) {
    return { winner: null, ambiguous: true };
  }

  let minDistance: bigint | null = null;
  for (const c of sameCurrency) {
    const d = amountDistance(c.amountCents, tx.amountCents);
    if (minDistance === null || d < minDistance) minDistance = d;
  }
  const nearest = sameCurrency.filter(
    (c) => amountDistance(c.amountCents, tx.amountCents) === minDistance,
  );

  if (nearest.length === 1) {
    const c = nearest[0]!;
    return {
      winner: {
        recurringId: c.recurringId,
        reason: "token+amount-nearest",
        sameAccount: c.accountId === tx.accountId,
      },
      ambiguous: false,
    };
  }

  const winner = breakTieByAccount(nearest, tx);
  if (winner) {
    return {
      winner: {
        recurringId: winner.recurringId,
        reason: "token+amount-nearest",
        sameAccount: true,
      },
      ambiguous: false,
    };
  }
  return { winner: null, ambiguous: true };
}

// ---------------------------------------------------------------------------
// Inverse direction — one recurring, many candidate transactions. Used by the
// monthly gap-closing cron (gap-detector.ts), which iterates per-recurring
// rather than per-transaction. Token → exact-amount → account rules match
// scoreMatchCandidates; the #857 1% leftover path does NOT. A single
// recurring cannot see sibling recurrings, so unique-near here would steal
// a tx that is also within 1% of a twin. That assignment lives in
// gap-detector.ts (global exact-then-near + blockedTxIds), not here.
// ---------------------------------------------------------------------------

export type TxCandidate = {
  txId: number;
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  descriptionRaw: string | null | undefined;
};

export type RecurringQuery = {
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  /** Union of ALL learned description-fingerprint patterns for this recurring. */
  patterns: string[];
};

export type TxMatchResult = {
  winner: TxCandidate | null;
  ambiguous: boolean;
};

const NO_TX_MATCH: TxMatchResult = { winner: null, ambiguous: false };

function breakTxTieByAccount(pool: TxCandidate[], recurring: RecurringQuery): TxCandidate | null {
  const sameAccountPool = pool.filter((c) => c.accountId === recurring.accountId);
  return sameAccountPool.length === 1 ? sameAccountPool[0]! : null;
}

/**
 * Pick the single transaction (among candidates already known to fall inside
 * the recurring's occurrence window) that this recurring's occurrence was
 * paid with — or null if ambiguous / no signal.
 */
export function pickTxForRecurring(
  recurring: RecurringQuery,
  candidates: TxCandidate[],
): TxMatchResult {
  if (candidates.length === 0) return NO_TX_MATCH;

  // Each candidate tx offers its OWN token (derived from its own
  // description) as the thing to check against the recurring's learned
  // pattern set — the mirror image of scoreMatchCandidates.
  const withToken = candidates.map((c) => ({ c, token: tokeniseDescription(c.descriptionRaw) }));

  const tokenMatches = withToken.filter(
    ({ token }) => token !== null && recurring.patterns.includes(token),
  );

  if (tokenMatches.length === 1) return { winner: tokenMatches[0]!.c, ambiguous: false };

  if (tokenMatches.length >= 2) {
    const pool = tokenMatches.map((m) => m.c);
    const exact = pool.filter((c) => isSameAmount(c, recurring));
    if (exact.length === 1) return { winner: exact[0]!, ambiguous: false };
    if (exact.length >= 2) {
      const winner = breakTxTieByAccount(exact, recurring);
      return winner ? { winner, ambiguous: false } : { winner: null, ambiguous: true };
    }
    const winner = breakTxTieByAccount(pool, recurring);
    return winner ? { winner, ambiguous: false } : { winner: null, ambiguous: true };
  }

  // No token signal at all among candidates. Amount-only fallback, but only
  // for candidates whose OWN token is null (unextractable) — a candidate
  // with an extractable-but-unmatched token is blocked, mirroring
  // scoreMatchCandidates' KFC/SmartFit protection.
  const amountOnlyPool = withToken.filter(({ token }) => token === null).map(({ c }) => c);
  const exact = amountOnlyPool.filter((c) => isSameAmount(c, recurring));
  if (exact.length === 1) return { winner: exact[0]!, ambiguous: false };
  return { winner: null, ambiguous: exact.length >= 2 };
}
