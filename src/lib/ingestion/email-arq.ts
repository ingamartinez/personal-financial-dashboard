import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { emit } from "@/lib/events/bus";
import { autoLinkTransaction } from "@/lib/recurring/auto-link";
import { parseArqEmail, type ArqParseResult, type ParsedArqTx } from "@/lib/gmail/parsers/arq";

const log = createLogger({ module: "ingestion/email-arq" });

// Label written to `transactions.source`. Keep in sync with txSource enum.
const ARQ_SOURCE = "gmail_arq" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IngestArqOutcome =
  | { status: "inserted"; txId: number }
  | { status: "duplicated" }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

// Minimal account shape needed for ARQ routing.
interface ArqAccount {
  id: number;
  currency: string;
  institutionSlug: string;
  metadata: { last4s?: string[] } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Account routing
// ---------------------------------------------------------------------------

/**
 * Resolve the ARQ Ahorros account for this user.
 *
 * ARQ Ahorros is a USD-denominated account seeded with institution_slug='other'
 * and last4s=['7073','1356'] (as of 2026-04-19 prod seed). We identify it by
 * currency='USD' + institutionSlug='other' + metadata.last4s containing a known
 * ARQ last4. The last4 check prevents routing to an unrelated USD account if the
 * user ever adds another foreign-currency wallet.
 *
 * Tenant safety: the query is already scoped by userId in the caller.
 */
const ARQ_KNOWN_LAST4S = new Set(["7073", "1356"]);

function resolveArqAccount(allAccounts: ArqAccount[]): ArqAccount | null {
  for (const acct of allAccounts) {
    if (acct.currency !== "USD") continue;
    const last4s: string[] = acct.metadata.last4s ?? [];
    if (last4s.some((l) => ARQ_KNOWN_LAST4S.has(l))) return acct;
  }
  return null;
}

// ---------------------------------------------------------------------------
// tx field builders
// ---------------------------------------------------------------------------

/**
 * Build the fx metadata block.
 *
 * ARQ Ahorros is USD-pure; USDc ≡ USD 1:1. For transfer_received there is no
 * COP leg, so trmSource='1_to_1'. For transfer_sent the email exposes both
 * USDc debited and COP sent, so we compute the implied TRM.
 *
 * This shape is canonical per the #508 design — #519 will consume it uniformly
 * regardless of whether it is a trivial 1:1 case or has a real TRM.
 */
function buildFxMetadata(parsed: ParsedArqTx): Record<string, unknown> {
  if (parsed.txKind === "transfer_received") {
    return {
      originalCurrency: "USD",
      originalAmountCents: parsed.amountUsdcCents.toString(),
      trmToAccountCurrency: 1,
      trmSource: "1_to_1",
    };
  }

  // transfer_sent
  const fx: Record<string, unknown> = {
    originalCurrency: "USD",
    originalAmountCents: parsed.amountUsdcCents.toString(),
    trmToAccountCurrency: parsed.impliedTrmCopPerUsdc ?? 1,
    trmSource: parsed.impliedTrmCopPerUsdc !== null ? "email_implied" : "1_to_1",
  };
  if (parsed.copAmountCents !== null) {
    fx.copAmountCents = parsed.copAmountCents.toString();
  }
  return fx;
}

// ---------------------------------------------------------------------------
// email_receipts helpers
// ---------------------------------------------------------------------------

async function markReceiptMatched(
  receiptId: number,
  userId: number,
  txId: number,
  parsed: ParsedArqTx,
): Promise<void> {
  await db
    .update(emailReceipts)
    .set({
      matchStatus: "matched",
      matchedTransactionId: txId,
      amountCents: parsed.amountUsdcCents,
      currency: "USD",
      occurredAt: parsed.occurredAt,
      merchant: parsed.counterpartyName,
      parsedPayload: {
        merchant: parsed.counterpartyName,
        amountCents: parsed.amountUsdcCents.toString(),
        currency: "USD",
        occurredAt: parsed.occurredAt.toISOString(),
        referenceId: null,
        extra: {
          txKind: parsed.txKind,
          counterpartyName: parsed.counterpartyName,
        },
      },
      parsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));
}

async function markReceiptSkipped(receiptId: number, userId: number): Promise<void> {
  await db
    .update(emailReceipts)
    .set({
      matchStatus: "unmatched",
      parsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));
}

// ---------------------------------------------------------------------------
// Main ingestion entry point
// ---------------------------------------------------------------------------

/**
 * Parse and ingest a single ARQ email receipt.
 *
 * Flow:
 *   1. Parser skip / needs_review → log and exit.
 *   2. Resolve ARQ Ahorros account for this user.
 *   3. Insert transaction with source='gmail_arq'. Idempotency by
 *      external_id=(accountId, 'arq-email-<receiptId>') — if the same receipt
 *      is processed twice (cron race, manual retry) the insert is a no-op.
 *   4. Mark email_receipts row as matched.
 *
 * Tenant safety: every DB read and write is scoped by userId.
 */
export async function ingestArqEmail(
  userId: number,
  receiptId: number,
  rawHtml: string,
  receivedAt: Date,
): Promise<IngestArqOutcome> {
  // --- Parse ---
  const parsed: ArqParseResult = parseArqEmail(rawHtml, { occurredAt: receivedAt });

  if (parsed.kind === "skip") {
    log.info(
      { userId, receiptId, reason: parsed.reason, event: "arq_email_skip" },
      "ARQ email is non-transactional; skipping",
    );
    await markReceiptSkipped(receiptId, userId);
    return { status: "skipped", reason: parsed.reason };
  }

  if (parsed.kind === "needs_review") {
    log.warn(
      { userId, receiptId, reason: parsed.reason, event: "arq_email_needs_review" },
      "ARQ email could not be parsed; leaving pending for retry",
    );
    return { status: "error", reason: `parser: ${parsed.reason}` };
  }

  // --- Account routing (tenant-safe: all accounts fetched for this userId) ---
  const allAccounts = await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)));

  const account = resolveArqAccount(allAccounts as ArqAccount[]);
  if (!account) {
    log.warn(
      { userId, receiptId, txKind: parsed.txKind, event: "arq_email_no_account" },
      "ARQ email parsed but no ARQ Ahorros account found for user",
    );
    return { status: "error", reason: "no ARQ Ahorros account found" };
  }

  // --- Build tx fields ---
  // Amount sign: positive for received (income), negative for sent (expense).
  const signedAmountCents =
    parsed.txKind === "transfer_received" ? parsed.amountUsdcCents : -parsed.amountUsdcCents;

  const fxMetadata = buildFxMetadata(parsed);

  // Stable idempotency key scoped to the receipt row. Using 'arq-email-<id>'
  // keeps this disjoint from any future statement-derived externalIds for the
  // same event (those will use a different prefix — #517).
  const externalId = `arq-email-${receiptId}`;

  const descriptionRaw =
    parsed.txKind === "transfer_received"
      ? `You received ${parsed.amountUsdcCents} USDc from ${parsed.counterpartyName}`
      : `You sent USDc to ${parsed.counterpartyName}`;

  const rawData: Record<string, unknown> = {
    kind: parsed.txKind,
    email_receipt_id: receiptId,
    arq: {
      // #518: cross-channel pairing will use recipient_name to match PEXTO
      // COLOMBIA Bancolombia transfers. Always populated regardless of txKind.
      recipient_name: parsed.counterpartyName,
    },
    fx: fxMetadata,
  };

  // --- Insert ---
  try {
    const result = await db
      .insert(transactions)
      .values({
        userId,
        accountId: account.id,
        occurredAt: parsed.occurredAt,
        amountCents: signedAmountCents,
        currency: "USD",
        descriptionRaw,
        merchant: parsed.counterpartyName,
        source: ARQ_SOURCE,
        channel: "transfer",
        externalId,
        rawData,
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
        where: sql`${transactions.externalId} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    if (result.length === 0) {
      log.info(
        { userId, receiptId, externalId, event: "arq_email_duplicate" },
        "ARQ email already ingested; skipping duplicate insert",
      );
      return { status: "duplicated" };
    }

    const txId = result[0].id;

    await markReceiptMatched(receiptId, userId, txId, parsed);
    await autoLinkTransaction(userId, txId);
    emit({ type: "transaction:created", id: txId, source: ARQ_SOURCE, timestamp: Date.now() });

    log.info(
      {
        userId,
        receiptId,
        txId,
        txKind: parsed.txKind,
        amountUsdcCents: parsed.amountUsdcCents.toString(),
        counterparty: parsed.counterpartyName,
        event: "arq_email_inserted",
      },
      "ARQ email ingested as transaction",
    );
    return { status: "inserted", txId };
  } catch (err) {
    log.error(
      { err, userId, receiptId, event: "arq_email_insert_failed" },
      "failed to insert ARQ email transaction",
    );
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Batch processor — called from pull.ts for all pending ARQ receipts
// ---------------------------------------------------------------------------

/**
 * Process all pending ARQ email receipts for a user. Called at the tail of
 * `pullForUser` so freshly-inserted receipts get ingested in the same cron
 * tick AND stale pending rows from a previous failure get retried.
 *
 * Per-receipt errors are logged and do NOT interrupt the loop.
 */
export async function processPendingArqReceipts(userId: number): Promise<void> {
  const pending = await db
    .select({
      id: emailReceipts.id,
      rawHtml: emailReceipts.rawHtml,
      createdAt: emailReceipts.createdAt,
    })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        eq(emailReceipts.gateway, "arq"),
        eq(emailReceipts.matchStatus, "pending"),
        notDeleted(emailReceipts.deletedAt),
      ),
    );

  for (const receipt of pending) {
    try {
      await ingestArqEmail(userId, receipt.id, receipt.rawHtml, receipt.createdAt);
    } catch (err) {
      log.error(
        {
          err,
          userId,
          receiptId: receipt.id,
          event: "arq_email_ingest_loop_failed",
        },
        "failed to ingest ARQ receipt; leaving as pending for retry",
      );
    }
  }
}
