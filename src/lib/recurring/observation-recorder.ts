// #633: Observation recorder — append one row to recurring_link_observations
// after every successful tx ↔ recurring link (manual + auto).
//
// Idempotent by design: the unique constraint on (user_id, recurring_id, tx_id,
// year_month) ensures retried jobs and race conditions never produce duplicates.
// ON CONFLICT DO NOTHING is the correct behaviour here — the observation already
// exists, nothing more is needed.
//
// Also upserts the description fingerprint table so pattern_count stays current
// for the auto-link fallback path (Section D).

import { eq, and, ne, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  recurringDescriptionPatterns,
  recurringLinkObservations,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "recurring/observation-recorder" });

type DbOrTrx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0] | DB;

export type RecordLinkObservationInput = {
  userId: number;
  recurringId: number;
  txId: number;
  yearMonth: string;
  manual: boolean;
};

/**
 * Bancolombia `provider_payment_sent` stores `Pago a ${providerName}` as
 * descriptionRaw (#852). Taking the first significant token then made every
 * such payment fingerprint as PAGO — EPM, APORTES, and any other provider
 * bill shared one verb, so the unique-token path never saw EMPRESAS and the
 * APORTES twins collided on a word that is not their identity.
 *
 * Skip only those payment-verb prefixes. Do not grow this into a stoplist:
 * stripping more English/Spanish filler widens what counts as unique.
 */
const PAYMENT_VERB_PREFIXES = new Set(["PAGO", "PAGASTE"]);

/**
 * Tokenise a raw description into a stable fingerprint token.
 *
 * Rules:
 *   1. Uppercase
 *   2. Strip all non-alphanumeric characters (keep spaces for splitting)
 *   3. Split on whitespace
 *   4. Skip payment-verb prefixes (PAGO / PAGASTE) and insignificant tokens
 *      (<3 chars or purely numeric)
 *   5. Take the first remaining significant token
 *   6. Return null if none found (including a description that is only verbs)
 *
 * Examples:
 *   "NETFLIX*DL"                          → "NETFLIX"
 *   "SPOTIFY P 12345"                     → "SPOTIFY"
 *   "GOOGLE *PLAY YOUTUBE"                → "GOOGLE"  (will clash — that's intentional)
 *   "Pago a EMPRESAS PUBLICAS DE MEDELLIN" → "EMPRESAS"
 *   "Pago a APORTES EN LINEA"             → "APORTES"
 *   "1234 5678"                           → null      (purely numeric)
 */
export function tokeniseDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, " ");
  const tokens = upper.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.length < 3 || !/[A-Z]/.test(tok)) continue;
    if (PAYMENT_VERB_PREFIXES.has(tok)) continue;
    return tok;
  }
  return null;
}

/**
 * Record a single observation for a manual or auto link event.
 *
 * 1. Looks up the tx to get amountCents, currency, descriptionRaw, accountId.
 * 2. Inserts into recurring_link_observations (idempotent via ON CONFLICT DO NOTHING).
 * 3. Upserts into recurring_description_patterns if the tx has a description token.
 *
 * Does NOT throw on insert conflicts — always resolves cleanly.
 */
export async function recordRecurringLinkObservation(
  input: RecordLinkObservationInput,
  database: DB = defaultDb,
): Promise<void> {
  const { userId, recurringId, txId, yearMonth, manual } = input;

  // Fetch the tx to get the fields we need for the observation row.
  const [tx] = await database
    .select({
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)))
    .limit(1);

  if (!tx) {
    log.warn(
      { event: "observation_tx_not_found", userId, txId, recurringId, yearMonth },
      "observation-recorder: tx not found — skipping",
    );
    return;
  }

  // 1. Insert observation (idempotent).
  await database
    .insert(recurringLinkObservations)
    .values({
      userId,
      recurringId,
      txId,
      yearMonth,
      realAmountCents: tx.amountCents,
      realCurrency: tx.currency,
      descriptionRaw: tx.descriptionRaw,
      accountId: tx.accountId,
      manual,
    })
    .onConflictDoNothing();

  log.info(
    { event: "observation_recorded", userId, recurringId, txId, yearMonth, manual },
    "recurring link observation recorded",
  );

  // 2. Upsert description fingerprint if we have a usable token.
  const pattern = tokeniseDescription(tx.descriptionRaw);
  if (!pattern) return;

  if (
    !(await shouldLearnPattern(
      userId,
      recurringId,
      pattern,
      { amountCents: tx.amountCents, currency: tx.currency },
      database,
    ))
  ) {
    log.info(
      {
        event: "pattern_learn_skipped_foreign_owner",
        userId,
        recurringId,
        pattern,
      },
      "skipped learning a fingerprint another recurring already owns",
    );
    return;
  }

  await database
    .insert(recurringDescriptionPatterns)
    .values({
      userId,
      recurringId,
      pattern,
      observationCount: 1,
      lastObservedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        recurringDescriptionPatterns.userId,
        recurringDescriptionPatterns.recurringId,
        recurringDescriptionPatterns.pattern,
      ],
      set: {
        observationCount: sql`${recurringDescriptionPatterns.observationCount} + 1`,
        lastObservedAt: new Date(),
      },
    });

  // #807: a stored "pattern_ambiguous" latch used to be written here and
  // checked by auto-link.ts. #804 replaced that read path with the shared
  // helper in src/lib/recurring/patterns.ts, which deliberately does NOT
  // filter on shared-token ambiguity — it's resolved by the token+amount
  // scorer instead. The flag became write-only dead state (and a one-way
  // latch that never cleared), so it was dropped rather than repaired. If a
  // shared-token signal is ever needed again (e.g. for UI: "this token is
  // shared with N recurrings"), derive it at read time with
  // count(distinct recurring_id) over (user_id, pattern) — do not
  // reintroduce a stored flag.
}

/**
 * #873: refuse to teach this recurring a fingerprint another recurring of
 * the same user already owns with a materially higher observation count,
 * unless this observation's amount+currency matches the recurring (a real
 * payment that happens to share a token, e.g. APPLE on iCloud vs Apple TV).
 *
 * "Materially higher" = the other row is already trusted (>= 2) AND at least
 * twice what this recurring would have after the increment. That blocks the
 * prod poison (COLMEDICA count 6 on #8 vs a first observation on rent) without
 * resurrecting the #807 pattern_ambiguous latch for ordinary shared tokens.
 */
async function shouldLearnPattern(
  userId: number,
  recurringId: number,
  pattern: string,
  tx: { amountCents: bigint; currency: string },
  database: DbOrTrx,
): Promise<boolean> {
  const others = await database
    .select({ observationCount: recurringDescriptionPatterns.observationCount })
    .from(recurringDescriptionPatterns)
    .where(
      and(
        eq(recurringDescriptionPatterns.userId, userId),
        eq(recurringDescriptionPatterns.pattern, pattern),
        ne(recurringDescriptionPatterns.recurringId, recurringId),
      ),
    );

  let otherMax = 0;
  for (const row of others) {
    if (row.observationCount > otherMax) otherMax = row.observationCount;
  }
  if (otherMax < 2) return true;

  const [mine] = await database
    .select({ observationCount: recurringDescriptionPatterns.observationCount })
    .from(recurringDescriptionPatterns)
    .where(
      and(
        eq(recurringDescriptionPatterns.userId, userId),
        eq(recurringDescriptionPatterns.recurringId, recurringId),
        eq(recurringDescriptionPatterns.pattern, pattern),
      ),
    );
  const myCount = mine?.observationCount ?? 0;
  if (otherMax < 2 * (myCount + 1)) return true;

  const [rec] = await database
    .select({
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      amountType: recurringTransactions.amountType,
    })
    .from(recurringTransactions)
    .where(and(eq(recurringTransactions.id, recurringId), eq(recurringTransactions.userId, userId)))
    .limit(1);

  if (!rec) return false;
  if (rec.amountType === "variable") return true;
  return rec.currency === tx.currency && rec.amountCents === tx.amountCents;
}

async function rederivePatternsFromObservations(
  userId: number,
  recurringId: number,
  database: DbOrTrx,
): Promise<void> {
  const remaining = await database
    .select({
      descriptionRaw: recurringLinkObservations.descriptionRaw,
      observedAt: recurringLinkObservations.observedAt,
      realAmountCents: recurringLinkObservations.realAmountCents,
      realCurrency: recurringLinkObservations.realCurrency,
    })
    .from(recurringLinkObservations)
    .where(
      and(
        eq(recurringLinkObservations.userId, userId),
        eq(recurringLinkObservations.recurringId, recurringId),
      ),
    );

  const acc = new Map<string, { count: number; lastObservedAt: Date }>();
  for (const row of remaining) {
    const token = tokeniseDescription(row.descriptionRaw);
    if (token === null) continue;
    // #864 recompute-from-observations, but each token must still pass the
    // same foreign-owner check as first-learn. The raw observation row is
    // always kept (audit); only the fingerprint is gated. Without this, a
    // previously-blocked COLMEDICA observation would be silently re-taught
    // the next time any other observation on this recurring is retracted.
    if (
      !(await shouldLearnPattern(
        userId,
        recurringId,
        token,
        { amountCents: row.realAmountCents, currency: row.realCurrency },
        database,
      ))
    ) {
      continue;
    }
    const existing = acc.get(token);
    if (!existing) {
      acc.set(token, { count: 1, lastObservedAt: row.observedAt });
      continue;
    }
    existing.count += 1;
    if (row.observedAt.getTime() > existing.lastObservedAt.getTime()) {
      existing.lastObservedAt = row.observedAt;
    }
  }

  await database
    .delete(recurringDescriptionPatterns)
    .where(
      and(
        eq(recurringDescriptionPatterns.userId, userId),
        eq(recurringDescriptionPatterns.recurringId, recurringId),
      ),
    );

  if (acc.size === 0) return;

  await database.insert(recurringDescriptionPatterns).values(
    [...acc.entries()].map(([pattern, v]) => ({
      userId,
      recurringId,
      pattern,
      observationCount: v.count,
      lastObservedAt: v.lastObservedAt,
    })),
  );
}

/**
 * #873: reverse a link's teaching. Deletes the observation for this
 * (user, recurring, tx) and re-derives that recurring's fingerprints from
 * whatever observations remain, so a "Deshacer match" actually undoes the
 * count-1 COLMEDICA poison instead of leaving it behind.
 *
 * Idempotent: no matching observation is a no-op besides the re-derive.
 */
export async function retractRecurringLinkObservation(
  input: { userId: number; txId: number; recurringId: number },
  database: DbOrTrx = defaultDb,
): Promise<void> {
  const { userId, txId, recurringId } = input;

  const deleted = await database
    .delete(recurringLinkObservations)
    .where(
      and(
        eq(recurringLinkObservations.userId, userId),
        eq(recurringLinkObservations.txId, txId),
        eq(recurringLinkObservations.recurringId, recurringId),
      ),
    )
    .returning({ id: recurringLinkObservations.id });

  await rederivePatternsFromObservations(userId, recurringId, database);

  if (deleted.length === 0) {
    log.info(
      { event: "observation_retract_noop", userId, txId, recurringId },
      "observation-recorder: nothing to retract",
    );
    return;
  }

  log.info(
    { event: "observation_retracted", userId, txId, recurringId },
    "recurring link observation retracted",
  );
}
