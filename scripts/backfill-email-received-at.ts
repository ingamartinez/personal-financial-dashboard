/**
 * Backfill script: populate email_receipts.email_received_at from Gmail's
 * `internalDate` for receipts ingested before #545.
 *
 * Also corrects transactions.occurred_at when the receipt is matched to a
 * transaction (matched_transaction_id IS NOT NULL) AND that transaction's
 * source is `gmail_arq` or `gmail_*` — i.e. cases where the original wrong
 * occurred_at came from the receipt-pull's createdAt fallback.
 *
 * Idempotent: re-running skips receipts that already have email_received_at.
 *
 * CLI flags:
 *   --dry-run           Print what would change without writing.
 *   --user-id=N         Only process receipts for user N (otherwise all users).
 *   --batch-size=N      Receipts fetched per Gmail API tick (default 25).
 *   --sleep-ms=N        Delay between batches to stay under quota (default 200).
 *
 * Usage:
 *   bun scripts/backfill-email-received-at.ts --dry-run
 *   bun scripts/backfill-email-received-at.ts --user-id=1
 *   bun scripts/backfill-email-received-at.ts
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { emailReceipts, transactions } from "../src/lib/db/schema";
import { getAuthedClient, isInvalidGrantError } from "../src/lib/gmail/client";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-email-received-at" });

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((a) => a.startsWith("--user-id="));
const BATCH_SIZE_ARG = args.find((a) => a.startsWith("--batch-size="));
const SLEEP_MS_ARG = args.find((a) => a.startsWith("--sleep-ms="));

const userIdFilter: number | null = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : null;
const batchSize: number = BATCH_SIZE_ARG ? Number(BATCH_SIZE_ARG.split("=")[1]) : 25;
const sleepMs: number = SLEEP_MS_ARG ? Number(SLEEP_MS_ARG.split("=")[1]) : 200;

if (userIdFilter !== null && (!Number.isFinite(userIdFilter) || userIdFilter <= 0)) {
  log.error({ userIdArg: USER_ID_ARG }, "--user-id must be a positive integer");
  process.exit(1);
}
if (!Number.isFinite(batchSize) || batchSize <= 0) {
  log.error({ batchSizeArg: BATCH_SIZE_ARG }, "--batch-size must be a positive integer");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface UserStats {
  userId: number;
  total: number;
  fetched: number;
  receiptsUpdated: number;
  txsUpdated: number;
  errors: number;
}

async function backfillUser(userId: number): Promise<UserStats> {
  const stats: UserStats = {
    userId,
    total: 0,
    fetched: 0,
    receiptsUpdated: 0,
    txsUpdated: 0,
    errors: 0,
  };

  let authed;
  try {
    authed = await getAuthedClient(userId);
  } catch (err) {
    log.warn(
      { err, userId, event: "gmail_client_unavailable" },
      "user has no usable Gmail connection; skipping",
    );
    return stats;
  }

  const pending = await db
    .select({
      id: emailReceipts.id,
      gmailMsgId: emailReceipts.gmailMsgId,
      matchedTxnId: emailReceipts.matchedTransactionId,
    })
    .from(emailReceipts)
    .where(and(eq(emailReceipts.userId, userId), isNull(emailReceipts.emailReceivedAt)));

  stats.total = pending.length;
  if (pending.length === 0) return stats;

  log.info(
    { userId, total: pending.length, dryRun: DRY_RUN, event: "backfill_user_start" },
    "starting backfill for user",
  );

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);

    for (const receipt of batch) {
      try {
        const res = await authed.gmail.users.messages.get({
          userId: "me",
          id: receipt.gmailMsgId,
          format: "metadata",
          metadataHeaders: ["Date"],
        });
        stats.fetched++;
        const internalDateStr = res.data.internalDate;
        if (!internalDateStr) {
          log.warn(
            { userId, receiptId: receipt.id, event: "no_internal_date" },
            "Gmail returned no internalDate for message",
          );
          continue;
        }
        const ms = Number(internalDateStr);
        if (!Number.isFinite(ms)) {
          log.warn(
            { userId, receiptId: receipt.id, internalDateStr, event: "invalid_internal_date" },
            "internalDate is not numeric; skipping",
          );
          continue;
        }
        const emailReceivedAt = new Date(ms);

        if (DRY_RUN) {
          log.info(
            {
              userId,
              receiptId: receipt.id,
              matchedTxnId: receipt.matchedTxnId,
              wouldSet: emailReceivedAt.toISOString(),
            },
            "[dry-run] would update receipt + maybe its tx",
          );
          continue;
        }

        await db
          .update(emailReceipts)
          .set({ emailReceivedAt, updatedAt: new Date() })
          .where(and(eq(emailReceipts.id, receipt.id), eq(emailReceipts.userId, userId)));
        stats.receiptsUpdated++;

        // If the receipt is matched to a tx whose source is gmail_*, the tx's
        // occurred_at was set from the wrong receivedAt fallback. Correct it.
        if (receipt.matchedTxnId !== null) {
          const updated = await db
            .update(transactions)
            .set({ occurredAt: emailReceivedAt, updatedAt: new Date() })
            .where(
              and(
                eq(transactions.id, receipt.matchedTxnId),
                eq(transactions.userId, userId),
                sql`${transactions.source}::text LIKE 'gmail_%'`,
              ),
            )
            .returning({ id: transactions.id });
          if (updated.length > 0) stats.txsUpdated++;
        }
      } catch (err) {
        stats.errors++;
        if (isInvalidGrantError(err)) {
          log.error(
            { err, userId, event: "invalid_grant_abort" },
            "Gmail token invalid for this user; aborting backfill for this user",
          );
          return stats;
        }
        log.error(
          { err, userId, receiptId: receipt.id, event: "fetch_failed" },
          "failed to refetch this receipt; continuing",
        );
      }
    }

    if (i + batchSize < pending.length) await sleep(sleepMs);
  }

  return stats;
}

async function main() {
  log.info({ dryRun: DRY_RUN, userIdFilter, batchSize, sleepMs }, "backfill start");

  const userIds: number[] = userIdFilter
    ? [userIdFilter]
    : (
        await db
          .selectDistinct({ userId: emailReceipts.userId })
          .from(emailReceipts)
          .where(isNull(emailReceipts.emailReceivedAt))
      ).map((r) => r.userId);

  if (userIds.length === 0) {
    log.info({ event: "nothing_to_backfill" }, "no receipts with NULL email_received_at");
    return;
  }

  const totals = { total: 0, fetched: 0, receiptsUpdated: 0, txsUpdated: 0, errors: 0 };
  for (const uid of userIds) {
    const s = await backfillUser(uid);
    log.info(
      {
        userId: s.userId,
        total: s.total,
        fetched: s.fetched,
        receiptsUpdated: s.receiptsUpdated,
        txsUpdated: s.txsUpdated,
        errors: s.errors,
        event: "backfill_user_done",
      },
      "user backfill complete",
    );
    totals.total += s.total;
    totals.fetched += s.fetched;
    totals.receiptsUpdated += s.receiptsUpdated;
    totals.txsUpdated += s.txsUpdated;
    totals.errors += s.errors;
  }

  log.info(
    { ...totals, dryRun: DRY_RUN, event: "backfill_complete" },
    "backfill complete across all users",
  );
}

await main();
process.exit(0);
