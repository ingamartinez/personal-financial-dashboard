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

import { eq, and, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  recurringLinkObservations,
  recurringDescriptionPatterns,
  transactions,
} from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "recurring/observation-recorder" });

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
