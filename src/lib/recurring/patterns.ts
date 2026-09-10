// #804: shared description-fingerprint pattern lookup — used by BOTH
// auto-link.ts (one tx vs many recurring candidates) and gap-detector.ts
// (one recurring vs many tx candidates) so the trust threshold cannot drift
// between the two directions again (a prior draft had auto-link.ts require
// observation_count >= 2 while gap-detector.ts's local copy forgot the
// filter entirely — caught in review).

import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { recurringDescriptionPatterns, recurringLinkObservations } from "@/lib/db/schema";
import { tokeniseDescription } from "@/lib/recurring/observation-recorder";
import type { Currency } from "@/lib/types";

/**
 * Fetch learned description-fingerprint patterns for the given recurrings,
 * keyed by recurringId. Requires observation_count >= 2 before trusting a
 * pattern — a single manual/auto link isn't enough signal yet. A token
 * shared by 2+ recurrings is NOT filtered out here — #804 redefines
 * ambiguity across recurrings as "requires a second signal" (resolved by
 * the token+amount scorer), not "disabled forever" (the old
 * pattern_ambiguous latch, dropped in #807).
 */
export async function fetchPatterns(
  userId: number,
  recurringIds: number[],
  database: DB = defaultDb,
): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (recurringIds.length === 0) return map;

  const rows = await database
    .select({
      recurringId: recurringDescriptionPatterns.recurringId,
      pattern: recurringDescriptionPatterns.pattern,
    })
    .from(recurringDescriptionPatterns)
    .where(
      and(
        eq(recurringDescriptionPatterns.userId, userId),
        inArray(recurringDescriptionPatterns.recurringId, recurringIds),
        sql`${recurringDescriptionPatterns.observationCount} >= 2`,
      ),
    );

  for (const r of rows) {
    if (r.pattern === null) continue;
    const arr = map.get(r.recurringId) ?? [];
    arr.push(r.pattern);
    map.set(r.recurringId, arr);
  }
  return map;
}

/** Set equality for learned pattern tokens. Empty sets compare equal (cold-start). */
export function patternSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const p of a) if (!b.has(p)) return false;
  return true;
}

/** Convenience wrapper for the single-recurring case (gap-detector.ts). */
export async function fetchPatternsForOne(
  userId: number,
  recurringId: number,
  database: DB = defaultDb,
): Promise<string[]> {
  const map = await fetchPatterns(userId, [recurringId], database);
  return map.get(recurringId) ?? [];
}

/**
 * #873: tokens seen on observations of these recurrings whose amount+currency
 * match `amountCents`/`currency`.
 *
 * This is NOT a lowering of `fetchPatterns`' observation_count >= 2 threshold.
 * Count-1 fingerprints stay untrusted. A wrong-amount mis-link (prod: COLMEDICA
 * at -11702 USD hanging off a COP rent recurring) cannot teach a token for a
 * different payment shape, so it never enters this map.
 *
 * Used by auto-link and the gap detector as a proven-sibling signal: one
 * prior link of this amount+token is enough to auto-link later months even
 * across accounts, which is how #804's "any card pays it" becomes reachable
 * without waiting for a second observation to promote the fingerprint.
 */
export async function fetchAmountConsistentTokens(
  userId: number,
  recurringIds: number[],
  amountCents: bigint,
  currency: Currency,
  database: DB = defaultDb,
): Promise<Map<number, string[]>> {
  const map = new Map<number, Set<string>>();
  if (recurringIds.length === 0) return new Map();

  const rows = await database
    .select({
      recurringId: recurringLinkObservations.recurringId,
      descriptionRaw: recurringLinkObservations.descriptionRaw,
    })
    .from(recurringLinkObservations)
    .where(
      and(
        eq(recurringLinkObservations.userId, userId),
        inArray(recurringLinkObservations.recurringId, recurringIds),
        eq(recurringLinkObservations.realAmountCents, amountCents),
        eq(recurringLinkObservations.realCurrency, currency),
      ),
    );

  for (const r of rows) {
    const token = tokeniseDescription(r.descriptionRaw);
    if (token === null) continue;
    const set = map.get(r.recurringId) ?? new Set<string>();
    set.add(token);
    map.set(r.recurringId, set);
  }

  const out = new Map<number, string[]>();
  for (const [id, set] of map) out.set(id, [...set]);
  return out;
}
