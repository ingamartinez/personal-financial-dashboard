import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, transactions, type SourceMismatchDetails } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { ingestBancolombiaTransaction, type IngestOutcome } from "@/lib/ingestion/sms-pipeline";
import {
  resolveAccountFromLast4,
  type BancolombiaParseResult,
  type ParsedBancolombiaTx,
  type RoutableAccount,
} from "@/lib/ingestion/bancolombia-variants";

const log = createLogger({ module: "ingestion/email-bancolombia" });

const COP_TIMEZONE_OFFSET = "-05:00";

// A+ dedup window around an email-derived tx: Bancolombia sends SMS and email
// at slightly different times for the same event, plus server clock skew can
// nudge timestamps. Five minutes is conservative enough that two genuinely
// distinct txs with identical amount+account+kind landing within the window
// is extraordinarily rare.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// Timestamp skew threshold for flagging source_mismatch. Within this window
// the two sources "agree" on occurred_at; beyond it we persist a diff entry.
// Separate from the dedup window so we match aggressively but flag strictly.
const TIMESTAMP_SKEW_FLAG_MS = 60 * 1000;

// Label under which this pipeline writes to `transactions.source` and
// `SourceMismatchDetails.{from,to}Source`. Keep in sync with the TxSource
// enum entry.
const EMAIL_SOURCE_LABEL = "gmail_bancolombia" as const;

/**
 * Main entry point for the email ingestion pipeline. Called by the pull
 * engine (#452) after a bancolombia-gateway email receipt is persisted.
 *
 * Flow:
 *   1. Parser returned skip/needs_review → record and exit.
 *   2. A+ dedup: if an existing tx matches by (user, account, amount, time
 *      window, parser kind), DO NOT insert a duplicate. If any bank-derived
 *      field differs, flag `source_mismatch` on the existing tx with a diff
 *      payload so divergence is auditable rather than silently overwritten.
 *   3. No match → delegate to `ingestBancolombiaTransaction` with
 *      source='gmail_bancolombia'. Same account routing, counterparty, and
 *      rule-based classification as the SMS path.
 *   4. On success, stamp the `email_receipts` row with `match_status` +
 *      `matched_transaction_id` + `parsed_payload` + `parsed_at` for audit
 *      and idempotency.
 *
 * Tenant isolation: every DB read and write is scoped by `userId`. The
 * account routing, the dedup query, and the receipt update all filter on
 * user_id — a caller that mishandles the userId cannot cross-pollinate
 * another tenant.
 */
export async function ingestParsedEmail(
  userId: number,
  parsed: BancolombiaParseResult,
  receiptId: number,
): Promise<IngestOutcome> {
  if (parsed.kind === "skip") {
    await markReceiptUnmatched(receiptId, userId);
    return { status: "skipped", reason: `parser: ${parsed.reason}` };
  }

  if (parsed.kind === "needs_review") {
    // Leave receipt in pending status so a future parser rev or manual
    // intervention can pick it up. No tx is inserted.
    log.warn(
      { userId, receiptId, event: "gmail_bancolombia_needs_review" },
      "bancolombia email could not be classified to a known kind",
    );
    return { status: "error", reason: "parser: unknown_pattern" };
  }

  // Resolve account — email receipt has no meaning without routing to one of
  // the user's accounts. Account errors abort BEFORE we do dedup because the
  // dedup query filters by account_id. `institution` and `type` are needed
  // for the provider_payment variant which lacks a last4 and routes by
  // "the Bancolombia savings account in this currency".
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

  const routed = resolveAccountForParsed(parsed, allAccounts);
  if (!routed) {
    log.warn(
      {
        userId,
        receiptId,
        kind: parsed.kind,
        currency: parsed.currency,
        event: "gmail_bancolombia_no_account",
      },
      "bancolombia email parsed but no account matched",
    );
    return { status: "error", reason: `no account matches for kind=${parsed.kind}` };
  }

  // A+ dedup against txs from ANY source (SMS, email, CSV, manual). Scoped
  // tenant-safe by both user_id AND account_id.
  const match = await findMatchingTransaction(userId, routed.id, parsed);
  if (match) {
    const diffs = computeDiffs(match, parsed);
    const flaggedMismatch = diffs.length > 0;
    if (flaggedMismatch) {
      await flagSourceMismatch(match.id, match.source ?? "unknown", diffs);
      log.info(
        {
          userId,
          receiptId,
          txId: match.id,
          existingSource: match.source,
          diffsCount: diffs.length,
          event: "gmail_bancolombia_source_mismatch_flagged",
        },
        "email receipt matched existing tx with diverging fields",
      );
    }
    await markReceiptMatched(receiptId, userId, match.id, parsed);
    return { status: "duplicated", flaggedMismatch, txId: match.id };
  }

  // No existing tx covers this event — insert fresh through the shared
  // pipeline so we get the same account routing, counterparty resolution,
  // and rule-based classification as the SMS path.
  const result = await ingestBancolombiaTransaction(userId, parsed, {
    source: EMAIL_SOURCE_LABEL,
    rawDataExtras: {
      email_receipt_id: receiptId,
      rawText: parsed.raw,
    },
  });

  if (result.status === "inserted") {
    await markReceiptMatched(receiptId, userId, result.txId, parsed);
  } else if (result.status === "duplicated") {
    // Same externalId already in DB — another pipeline (parallel pull, race)
    // beat us to the insert. Still flag the receipt as matched without a
    // target, so we stop re-processing it.
    await markReceiptUnmatched(receiptId, userId);
  }
  return result;
}

// -----------------------------------------------------------------------------
// Account routing (thin wrapper so email needs only the minimal account shape)
// -----------------------------------------------------------------------------

function resolveAccountForParsed(
  parsed: ParsedBancolombiaTx,
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
    case "tc_payment":
      // TC payment routes the origin (savings) account; the shared inserter
      // handles the paired TC leg.
      return resolveAccountFromLast4(parsed.fromLast4, parsed.currency, allAccounts);
    case "tc_credit_received":
      return resolveAccountFromLast4(parsed.toCardLast4, parsed.currency, allAccounts);
    case "provider_payment":
      // Provider payment SMS says only "tu cuenta de Ahorros" with no last4 —
      // routes to the user's Bancolombia savings in this currency.
      return (
        allAccounts.find(
          (a) =>
            a.institution === "Bancolombia" &&
            a.type === "savings" &&
            a.currency === parsed.currency,
        ) ?? null
      );
    case "cartera_tc":
      // Cartera TC is handled by the SMS wire path directly; the email pipeline
      // does not encounter this kind. Return null so the email path skips it.
      return null;
  }
}

// -----------------------------------------------------------------------------
// A+ dedup
// -----------------------------------------------------------------------------

interface ExistingTxForDedup {
  id: number;
  accountId: number;
  amountCents: bigint;
  occurredAt: Date;
  merchant: string | null;
  source: string;
  rawData: { kind?: string } & Record<string, unknown>;
}

async function findMatchingTransaction(
  userId: number,
  accountId: number,
  parsed: ParsedBancolombiaTx,
): Promise<ExistingTxForDedup | null> {
  const occurredAt = parsedOccurredAt(parsed);
  const windowStart = new Date(occurredAt.getTime() - DEDUP_WINDOW_MS);
  const windowEnd = new Date(occurredAt.getTime() + DEDUP_WINDOW_MS);

  // Signed amount: SMS pipeline stores purchases as negative, incoming
  // transfers as positive. Match both possibilities — the parser doesn't
  // know what sign the existing tx has because legacy CSV imports may use
  // conventions we don't enforce.
  const signedAmount = parsed.amountCents;
  const negatedAmount = -parsed.amountCents;

  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      merchant: transactions.merchant,
      source: transactions.source,
      rawData: transactions.rawData,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        sql`(${transactions.amountCents} = ${signedAmount} OR ${transactions.amountCents} = ${negatedAmount})`,
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        notDeleted(transactions.deletedAt),
      ),
    )
    .limit(5);

  // Prefer same-kind matches; if none, fall back to kind-agnostic (covers
  // CSV/manual inserts whose rawData may not carry a `kind`).
  const sameKind = rows.find((r) => {
    const raw = (r.rawData ?? {}) as { kind?: string };
    return raw.kind === parsed.kind;
  });
  const pick = sameKind ?? rows[0];
  if (!pick) return null;

  return {
    id: pick.id,
    accountId: pick.accountId,
    amountCents: pick.amountCents,
    occurredAt: pick.occurredAt,
    merchant: pick.merchant,
    source: pick.source,
    rawData: (pick.rawData ?? {}) as ExistingTxForDedup["rawData"],
  };
}

function parsedOccurredAt(parsed: ParsedBancolombiaTx): Date {
  // cartera_tc has no date in the SMS; callers in the email path don't encounter
  // it but we need to be exhaustive for TypeScript.
  if (!("occurredOn" in parsed)) return new Date();
  return new Date(`${parsed.occurredOn}T${parsed.occurredTime}:00${COP_TIMEZONE_OFFSET}`);
}

// -----------------------------------------------------------------------------
// Diff computation for source_mismatch
// -----------------------------------------------------------------------------

type Diff = SourceMismatchDetails["diffs"][number];

function computeDiffs(existing: ExistingTxForDedup, parsed: ParsedBancolombiaTx): Diff[] {
  const diffs: Diff[] = [];
  const parsedOccurred = parsedOccurredAt(parsed);
  const skewMs = Math.abs(parsedOccurred.getTime() - existing.occurredAt.getTime());
  if (skewMs > TIMESTAMP_SKEW_FLAG_MS) {
    diffs.push({
      field: "occurredAt",
      fromValue: existing.occurredAt.toISOString(),
      toValue: parsedOccurred.toISOString(),
    });
  }

  // Merchant — only kinds that carry one. Case-insensitive equality so
  // "MERCADOPAGO" vs "Mercadopago" aren't flagged.
  const parsedMerchant = merchantFromParsed(parsed);
  if (parsedMerchant !== null) {
    const existingMerchant = (existing.merchant ?? "").trim();
    if (existingMerchant.toLowerCase() !== parsedMerchant.toLowerCase()) {
      diffs.push({
        field: "merchant",
        fromValue: existing.merchant,
        toValue: parsedMerchant,
      });
    }
  }

  // Parser-kind divergence — the two sources disagree on what event shape
  // this is. Noteworthy because downstream classification branches on it.
  const existingKind = existing.rawData.kind;
  if (existingKind && existingKind !== parsed.kind) {
    diffs.push({ field: "kind", fromValue: existingKind, toValue: parsed.kind });
  }

  return diffs;
}

function merchantFromParsed(parsed: ParsedBancolombiaTx): string | null {
  switch (parsed.kind) {
    case "purchase":
      return parsed.merchant;
    case "provider_payment_sent":
      return parsed.providerName;
    case "provider_payment":
    case "transfer_received":
    case "tc_credit_received":
      return parsed.senderName;
    case "bre_b_transfer":
      return parsed.recipientName;
    case "transfer_sent":
    case "qr_payment":
    case "tc_payment":
    case "atm_withdrawal":
    case "cartera_tc":
      return null;
  }
}

// -----------------------------------------------------------------------------
// email_receipts updates
// -----------------------------------------------------------------------------

async function markReceiptMatched(
  receiptId: number,
  userId: number,
  txId: number,
  parsed: ParsedBancolombiaTx,
): Promise<void> {
  await db
    .update(emailReceipts)
    .set({
      matchStatus: "matched",
      matchedTransactionId: txId,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      occurredAt: parsedOccurredAt(parsed),
      merchant: merchantFromParsed(parsed),
      parsedPayload: {
        merchant: merchantFromParsed(parsed) ?? "",
        amountCents: parsed.amountCents.toString(),
        currency: parsed.currency,
        occurredAt: parsedOccurredAt(parsed).toISOString(),
        referenceId: null,
        extra: { kind: parsed.kind, externalId: parsed.externalId },
      },
      parsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));
}

async function markReceiptUnmatched(receiptId: number, userId: number): Promise<void> {
  await db
    .update(emailReceipts)
    .set({
      matchStatus: "unmatched",
      parsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));
}

async function flagSourceMismatch(txId: number, fromSource: string, diffs: Diff[]): Promise<void> {
  const details: SourceMismatchDetails = {
    fromSource,
    toSource: EMAIL_SOURCE_LABEL,
    diffs,
  };
  await db
    .update(transactions)
    .set({
      sourceMismatch: true,
      sourceMismatchDetails: details,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, txId));
}
