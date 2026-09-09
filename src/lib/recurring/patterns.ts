// #804: shared description-fingerprint pattern lookup — used by BOTH
// auto-link.ts (one tx vs many recurring candidates) and gap-detector.ts
// (one recurring vs many tx candidates) so the trust threshold cannot drift
// between the two directions again (a prior draft had auto-link.ts require
// observation_count >= 2 while gap-detector.ts's local copy forgot the
// filter entirely — caught in review).

import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { recurringDescriptionPatterns } from "@/lib/db/schema";

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
