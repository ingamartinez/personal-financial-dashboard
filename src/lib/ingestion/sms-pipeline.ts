import { and, eq, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { classifyByRule } from "@/lib/classification/rules";
import { emit } from "@/lib/events/bus";
import { autoLinkTransaction } from "@/lib/recurring/auto-link";
import { insertTransferGroup } from "@/lib/transactions/transfer-groups";
import { pairIntraUserTransfer } from "@/lib/transfers/intra-user-pair";
import {
  resolveAccountFromLast4,
  type ParseResult,
  type ParsedSms,
  type RoutableAccount,
} from "@/lib/ingestion/sms-bancolombia";
import {
  aiFallbackParseSms,
  isAiFallbackEnabled,
  recordParseSkip,
  recordParseSuccess,
  recordParserEvent,
  type AiFallbackOutcome,
} from "@/lib/ingestion/sms-ai-fallback";
import { keyForParsed } from "@/lib/counterparties/alias-key";
import type { ClassificationMethod, TransactionSource } from "@/lib/types";

// Colombia uses UTC-5 year-round (no DST). Time in SMS is local.
const COP_TIMEZONE_OFFSET = "-05:00";

export type IngestOutcome =
  | { status: "inserted"; txId: number; via?: "regex" | "ai_fallback" }
  // `flaggedMismatch` is set by the email pipeline when a duplicate was
  // detected AND the existing tx had divergences that were recorded on the
  // tx's `source_mismatch_details`. SMS callers leave it undefined.
  | { status: "duplicated"; flaggedMismatch?: boolean }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

// Per-source configuration consumed by the shared Bancolombia tx inserter.
// `source` goes into `transactions.source`; `rawDataExtras` is spread into
// `transactions.raw_data` alongside the parsed `kind`. Callers are SMS (#245),
// email (#457), and future iOS-native ingestion (#Phase-5).
export interface IngestSourceConfig {
  source: TransactionSource;
  rawDataExtras: Record<string, unknown>;
}

/**
 * Pure ingestion logic — testable in isolation and reusable by the HTTP route,
 * replay scripts, and the Ingestion Inbox retry flow.
 *
 * `opts.forceAccountId` is used by the retry path (#261): bypass last4/currency
 * routing and use the account the user picked in the inbox. Currency is still
 * enforced so a wrong-currency account never gets a mismatched amount.
 *
 * `opts.aiFallbackFetchImpl` is a test seam — the SMS AI fallback path uses
 * the Anthropic SDK, and tests inject a mock fetch. Production callers leave
 * it undefined so the SDK uses its real transport.
 */
export async function ingestParsed(
  userId: number,
  parsed: ParseResult,
  opts?: { forceAccountId?: number; aiFallbackFetchImpl?: typeof fetch },
): Promise<IngestOutcome> {
  if (parsed.kind === "skip") {
    await recordParseSkip({ userId, reason: parsed.reason, raw: parsed.raw });
    return { status: "skipped", reason: `parser: ${parsed.reason}` };
  }

  // needs_review: the regex parser could not match any known shape. Either
  // invoke the AI fallback (#257) or surface to the inbox. Either path emits
  // exactly one parser_events row for the SLO dashboard (#329).
  if (parsed.kind === "needs_review") {
    return ingestNeedsReviewWithAiFallback(userId, parsed.raw, opts?.aiFallbackFetchImpl);
  }

  // Regex happy path (#329 PR1). Emit telemetry BEFORE delegating so the SLO
  // denominator counts "SMS we could understand" independent of whether the
  // DB insert ultimately succeeds, is duplicated, or fails on routing.
  await recordParseSuccess({ userId, regexOutcome: serializeParsed(parsed) });
  return ingestParsedBancolombia(
    userId,
    parsed,
    { source: "sms", rawDataExtras: { sms: parsed.raw } },
    opts?.forceAccountId,
  );
}

/**
 * Shared entry point for non-SMS callers (email — #457, future iOS native —
 * Phase 5). SMS goes through `ingestParsed` so it also runs the AI fallback
 * for `needs_review`; other sources handle their own pre-insert logic (e.g.
 * email does A+ dedup in `ingestParsedEmail`) and only hand off a regex-
 * matched `ParsedSms` here.
 */
export async function ingestBancolombiaTransaction(
  userId: number,
  parsed: ParsedSms,
  cfg: IngestSourceConfig,
  opts?: { forceAccountId?: number },
): Promise<IngestOutcome> {
  return ingestParsedBancolombia(userId, parsed, cfg, opts?.forceAccountId);
}

async function ingestNeedsReviewWithAiFallback(
  userId: number,
  rawBody: string,
  fetchImpl: typeof fetch | undefined,
): Promise<IngestOutcome> {
  const regexOutcome = {
    kind: "needs_review" as const,
    reason: "unknown_pattern" as const,
    raw: rawBody,
  };
  const enabled = await isAiFallbackEnabled(userId);

  if (!enabled) {
    await recordParserEvent({
      userId,
      outcome: { status: "disabled" },
      regexOutcome,
      latencyMs: 0,
    });
    return { status: "error", reason: "parser: unknown_pattern (ai fallback disabled)" };
  }

  const startedAt = Date.now();
  const outcome: AiFallbackOutcome = await aiFallbackParseSms(rawBody, { fetchImpl });
  const latencyMs = Date.now() - startedAt;

  await recordParserEvent({ userId, outcome, regexOutcome, latencyMs });

  if (outcome.status !== "success") {
    const detail =
      outcome.status === "low_confidence"
        ? `confidence=${outcome.confidence.toFixed(2)}`
        : `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}`;
    return { status: "error", reason: `ai_fallback: ${outcome.status} (${detail})` };
  }

  const result = await ingestParsedBancolombia(
    userId,
    outcome.parsed,
    {
      source: "sms",
      rawDataExtras: {
        sms: outcome.parsed.raw,
        parsedBy: "ai_fallback",
        aiConfidence: outcome.confidence,
      },
    },
    undefined,
  );
  // Tag successful AI-fallback inserts so callers (and the SMS route log) can
  // distinguish them from the regex path.
  if (result.status === "inserted") return { ...result, via: "ai_fallback" };
  return result;
}

async function ingestParsedBancolombia(
  userId: number,
  parsed: ParsedSms,
  cfg: IngestSourceConfig,
  forceAccountId: number | undefined,
): Promise<IngestOutcome> {
  const allAccounts = (await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      metadata: accounts.metadata,
      institution: accounts.institution,
      type: accounts.type,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)))) as Array<
    RoutableAccount & { institution: string; type: string }
  >;

  // TC statement payment (#405): origin savings ↔ TC destination are both
  // user accounts, so insert as a paired transfer group. Ingest-level, not
  // through the generic single-insert path below.
  if (parsed.kind === "tc_payment") {
    return ingestTcStatementPayment(userId, parsed, allAccounts, cfg, forceAccountId);
  }
  // TC credit received (#405): the SMS tells us ONLY the TC destination; the
  // origin account is external (another bank, Nequi, cash deposit, 3rd-party
  // transfer). Insert as a single unpaired transfer leg — user can pair
  // manually from /transactions if the other side is also a findash account.
  if (parsed.kind === "tc_credit_received") {
    return ingestTcCreditReceived(userId, parsed, allAccounts, cfg, forceAccountId);
  }

  let account: RoutableAccount | null;
  if (forceAccountId !== undefined) {
    const forced = allAccounts.find((a) => a.id === forceAccountId);
    if (!forced) {
      return { status: "error", reason: `account ${forceAccountId} not found for user` };
    }
    if (forced.currency !== parsed.currency) {
      return {
        status: "error",
        reason: `currency mismatch: parsed=${parsed.currency}, account=${forced.currency}`,
      };
    }
    account = forced;
  } else {
    account = resolveAccountForParsed(parsed, allAccounts);
  }

  if (!account) {
    return {
      status: "error",
      reason: `no account matches for kind=${parsed.kind}`,
    };
  }

  const occurredAt = new Date(
    `${parsed.occurredOn}T${parsed.occurredTime}:00${COP_TIMEZONE_OFFSET}`,
  );
  const { amountCents, descriptionRaw, merchant, categorySlug, method } = buildTxFields(parsed);

  const cp = await resolveCounterparty(userId, parsed, db);

  let finalCategory = cp.inheritedCategory ?? categorySlug;
  let finalMethod: Exclude<ClassificationMethod, "ai"> = cp.inheritedCategory ? "rule" : method;
  let confidence: number | null = null;
  const shouldAttemptRule =
    !cp.inheritedCategory &&
    (parsed.kind === "purchase" ||
      parsed.kind === "provider_payment_sent" ||
      parsed.kind === "qr_payment");
  if (shouldAttemptRule) {
    const cls = await classifyByRule(userId, { descriptionRaw, merchant });
    if (cls) {
      finalCategory = cls.categorySlug;
      finalMethod = "rule";
      confidence = cls.confidence;
    } else {
      finalMethod = "unclassified";
    }
  }

  try {
    const result = await db
      .insert(transactions)
      .values({
        userId,
        accountId: account.id,
        occurredAt,
        amountCents,
        currency: parsed.currency,
        descriptionRaw,
        descriptionClean: null,
        merchant,
        categorySlug: finalCategory,
        counterpartyId: cp.counterpartyId,
        classificationMethod: finalMethod,
        classificationConfidence: confidence,
        source: cfg.source,
        externalId: parsed.externalId,
        rawData: {
          kind: parsed.kind,
          ...cfg.rawDataExtras,
        },
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
        where: sql`${transactions.externalId} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    if (result.length === 0) return { status: "duplicated" };
    const txId = result[0].id;
    await autoLinkTransaction(userId, txId);
    emit({
      type: "transaction:created",
      id: txId,
      source: cfg.source,
      timestamp: Date.now(),
    });
    // #518: attempt intra-user transfer pairing for transfer_sent / transfer_received.
    // Only these two kinds can be part of a self-transfer pair. Other kinds (purchase,
    // provider_payment, atm_withdrawal, etc.) are never paired here.
    if (parsed.kind === "transfer_sent" || parsed.kind === "transfer_received") {
      await pairIntraUserTransfer(
        {},
        {
          id: txId,
          userId,
          accountId: account.id,
          channel: "transfer",
          amountCents,
          currency: parsed.currency,
          occurredAt,
          counterpartyId: cp.counterpartyId,
          // merchant is the parsed counterparty name in these SMS kinds.
          counterparty: merchant,
          rawData: { kind: parsed.kind, ...cfg.rawDataExtras },
        },
      );
    }
    return { status: "inserted", txId };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

type CounterpartyResolution = {
  counterpartyId: number | null;
  inheritedCategory: string | null;
};

export async function resolveCounterparty(
  userId: number,
  parsed: ParsedSms,
  database: DB,
): Promise<CounterpartyResolution> {
  const key = keyForParsed(parsed);
  if (!key) return { counterpartyId: null, inheritedCategory: null };

  return database.transaction(async (trx) => {
    const existing = await trx.execute<{
      id: number;
      default_category_slug: string | null;
    }>(sql`
      SELECT c.id, c.default_category_slug
      FROM counterparty_aliases a
      JOIN counterparties c ON c.id = a.counterparty_id
      WHERE a.user_id = ${userId}
        AND a.kind = ${key.kind}::counterparty_key_kind
        AND a.value = ${key.value}
      LIMIT 1
    `);

    if (existing.length > 0) {
      await trx.execute(sql`
        UPDATE counterparties
        SET hit_count = hit_count + 1, last_hit_at = now()
        WHERE user_id = ${userId} AND id = ${existing[0].id}
      `);
      return {
        counterpartyId: existing[0].id,
        inheritedCategory: existing[0].default_category_slug,
      };
    }

    const inserted = await trx.execute<{ id: number }>(sql`
      INSERT INTO counterparties (user_id, display_name, type, hit_count, last_hit_at)
      VALUES (${userId}, ${key.initialDisplayName}, 'unknown', 1, now())
      RETURNING id
    `);
    await trx.execute(sql`
      INSERT INTO counterparty_aliases (user_id, counterparty_id, kind, value)
      VALUES (${userId}, ${inserted[0].id}, ${key.kind}::counterparty_key_kind, ${key.value})
    `);
    return { counterpartyId: inserted[0].id, inheritedCategory: null };
  });
}

function resolveAccountForParsed(
  parsed: Exclude<ParsedSms, { kind: "tc_payment" | "tc_credit_received" }>,
  allAccounts: Array<RoutableAccount & { institution: string; type: string }>,
): RoutableAccount | null {
  switch (parsed.kind) {
    case "purchase":
      return resolveAccountFromLast4(parsed.cardLast4, parsed.currency, allAccounts);
    case "transfer_sent":
    case "qr_payment":
    case "provider_payment_sent":
    case "atm_withdrawal":
    case "bre_b_transfer":
      return resolveAccountFromLast4(parsed.fromLast4, parsed.currency, allAccounts);
    case "transfer_received":
      return resolveAccountFromLast4(parsed.toLast4, parsed.currency, allAccounts);
    case "provider_payment": {
      return (
        allAccounts.find(
          (a) =>
            a.institution === "Bancolombia" &&
            a.type === "savings" &&
            a.currency === parsed.currency,
        ) ?? null
      );
    }
  }
}

// #405: TC statement payment — paired transfer group (savings debit + TC credit).
// Both accounts must exist in findash; otherwise we bail with an explicit error
// so the ingestion-inbox retry path can surface it. The old single-tx path used
// to insert into savings with categorySlug="pago-tc" (a child of "deudas"),
// which double-counted the original TC purchases as debt. This replaces it.
async function ingestTcStatementPayment(
  userId: number,
  parsed: ParsedSms & { kind: "tc_payment" },
  allAccounts: Array<RoutableAccount & { institution: string; type: string }>,
  cfg: IngestSourceConfig,
  forceAccountId: number | undefined,
): Promise<IngestOutcome> {
  let fromAcc: RoutableAccount | null;
  if (forceAccountId !== undefined) {
    const forced = allAccounts.find((a) => a.id === forceAccountId);
    if (!forced) {
      return { status: "error", reason: `account ${forceAccountId} not found for user` };
    }
    if (forced.currency !== parsed.currency) {
      return {
        status: "error",
        reason: `currency mismatch: parsed=${parsed.currency}, account=${forced.currency}`,
      };
    }
    fromAcc = forced;
  } else {
    fromAcc = resolveAccountFromLast4(parsed.fromLast4, parsed.currency, allAccounts);
  }
  if (!fromAcc) {
    return {
      status: "error",
      reason: `no source account matches last4=${parsed.fromLast4} currency=${parsed.currency}`,
    };
  }

  const toAcc = resolveAccountFromLast4(parsed.toCardLast4, parsed.currency, allAccounts);
  if (!toAcc) {
    return {
      status: "error",
      reason: `no TC account matches last4=${parsed.toCardLast4} currency=${parsed.currency} — add the card in /settings/accounts before ingesting`,
    };
  }

  const occurredAt = new Date(
    `${parsed.occurredOn}T${parsed.occurredTime}:00${COP_TIMEZONE_OFFSET}`,
  );
  const descriptionRaw = `Pago TC *${parsed.toCardLast4}`;
  const result = await insertTransferGroup({
    userId,
    legs: [
      {
        accountId: fromAcc.id,
        amountCents: -parsed.amountCents,
        currency: parsed.currency,
        descriptionRaw,
        source: cfg.source,
        occurredAt,
        externalId: parsed.externalId,
        rawData: { kind: parsed.kind, ...cfg.rawDataExtras, role: "debit" },
      },
      {
        accountId: toAcc.id,
        amountCents: parsed.amountCents,
        currency: parsed.currency,
        descriptionRaw,
        source: cfg.source,
        occurredAt,
        externalId: parsed.externalId,
        rawData: { kind: parsed.kind, ...cfg.rawDataExtras, role: "credit" },
      },
    ],
  });

  if (result.status === "duplicated") return { status: "duplicated" };
  if (result.status === "error") return { status: "error", reason: result.reason };

  for (const txId of result.txIds) {
    emit({ type: "transaction:created", id: txId, source: cfg.source, timestamp: Date.now() });
  }
  // Contract: IngestOutcome carries a single txId. Return the origin (debit)
  // leg — it's the one users recognize as "their payment" in logs and UI.
  return { status: "inserted", txId: result.txIds[0] };
}

// #405: TC credit received — an abono landing on a TC from an external source.
// The SMS gives us the TC destination (toCardLast4) and the senderName, but no
// origin account we can route to. We insert a single transfer leg (channel =
// "transfer", category_slug = null) so the balance moves correctly without
// polluting spend/income. If the user later identifies the origin as one of
// their accounts, they can pair it manually from /transactions.
async function ingestTcCreditReceived(
  userId: number,
  parsed: ParsedSms & { kind: "tc_credit_received" },
  allAccounts: Array<RoutableAccount & { institution: string; type: string }>,
  cfg: IngestSourceConfig,
  forceAccountId: number | undefined,
): Promise<IngestOutcome> {
  let toAcc: RoutableAccount | null;
  if (forceAccountId !== undefined) {
    const forced = allAccounts.find((a) => a.id === forceAccountId);
    if (!forced) {
      return { status: "error", reason: `account ${forceAccountId} not found for user` };
    }
    if (forced.currency !== parsed.currency) {
      return {
        status: "error",
        reason: `currency mismatch: parsed=${parsed.currency}, account=${forced.currency}`,
      };
    }
    toAcc = forced;
  } else {
    toAcc = resolveAccountFromLast4(parsed.toCardLast4, parsed.currency, allAccounts);
  }
  if (!toAcc) {
    return {
      status: "error",
      reason: `no TC account matches last4=${parsed.toCardLast4} currency=${parsed.currency}`,
    };
  }

  const occurredAt = new Date(
    `${parsed.occurredOn}T${parsed.occurredTime}:00${COP_TIMEZONE_OFFSET}`,
  );
  const descriptionRaw = `Abono de ${parsed.senderName} a TC *${parsed.toCardLast4}`;

  try {
    const result = await db
      .insert(transactions)
      .values({
        userId,
        accountId: toAcc.id,
        occurredAt,
        amountCents: parsed.amountCents,
        currency: parsed.currency,
        descriptionRaw,
        descriptionClean: null,
        merchant: parsed.senderName,
        categorySlug: null,
        counterpartyId: null,
        classificationMethod: "manual",
        classificationConfidence: null,
        source: cfg.source,
        channel: "transfer",
        externalId: parsed.externalId,
        rawData: { kind: parsed.kind, ...cfg.rawDataExtras },
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
        where: sql`${transactions.externalId} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    if (result.length === 0) return { status: "duplicated" };
    emit({
      type: "transaction:created",
      id: result[0].id,
      source: cfg.source,
      timestamp: Date.now(),
    });
    return { status: "inserted", txId: result[0].id };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildTxFields(parsed: Exclude<ParsedSms, { kind: "tc_payment" | "tc_credit_received" }>): {
  amountCents: bigint;
  descriptionRaw: string;
  merchant: string | null;
  categorySlug: string | null;
  method: Exclude<ClassificationMethod, "ai">;
} {
  switch (parsed.kind) {
    case "purchase":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: parsed.merchant,
        merchant: parsed.merchant,
        categorySlug: null,
        method: "unclassified",
      };
    case "transfer_sent":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Transferencia${parsed.isQR ? " QR" : ""} a cuenta *${parsed.toAccount}`,
        merchant: null,
        categorySlug: "transferencias",
        method: "manual",
      };
    case "qr_payment":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Pago QR a llave ${parsed.toKey}`,
        merchant: null,
        categorySlug: null,
        method: "unclassified",
      };
    case "transfer_received":
      return {
        amountCents: parsed.amountCents,
        descriptionRaw: `Transferencia recibida de ${parsed.senderName}`,
        merchant: parsed.senderName,
        categorySlug: "ingresos",
        method: "manual",
      };
    case "provider_payment":
      return {
        amountCents: parsed.amountCents,
        descriptionRaw: `Pago PROVEEDOR de ${parsed.senderName}`,
        merchant: parsed.senderName,
        categorySlug: "ingresos",
        method: "manual",
      };
    case "provider_payment_sent":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Pago a ${parsed.providerName}`,
        merchant: parsed.providerName,
        categorySlug: null,
        method: "unclassified",
      };
    case "atm_withdrawal":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Retiro ATM ${parsed.atmCode}`,
        merchant: null,
        categorySlug: null,
        method: "unclassified",
      };
    case "bre_b_transfer":
      return {
        amountCents: -parsed.amountCents,
        descriptionRaw: `Transferencia Bre-b a ${parsed.recipientName}`,
        merchant: parsed.recipientName,
        categorySlug: null,
        method: "unclassified",
      };
  }
}

export function serializeParsed(parsed: ParseResult): Record<string, unknown> {
  if (parsed.kind === "skip" || parsed.kind === "needs_review") {
    return { kind: parsed.kind, reason: parsed.reason, raw: parsed.raw };
  }
  return {
    ...parsed,
    amountCents: parsed.amountCents.toString(),
  };
}
