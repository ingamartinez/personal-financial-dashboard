// #553 — Backfill module: populate email_receipts.email_received_at from
// Gmail's `internalDate` for receipts ingested before #545. Also corrects
// transactions.occurred_at when the receipt is matched to a tx whose source
// is gmail_* — those rows took the wrong cron-run timestamp from the
// receivedAt fallback.
//
// Idempotent: receipts with email_received_at already set are skipped.
// Exposed via /api/cron/backfill-email-received-at.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, transactions } from "@/lib/db/schema";
import { getAuthedClient, isInvalidGrantError } from "@/lib/gmail/client";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/backfill-received-at" });

export interface BackfillOptions {
  dryRun?: boolean;
  userId?: number;
  batchSize?: number;
  sleepMs?: number;
}

export interface UserStats {
  userId: number;
  total: number;
  fetched: number;
  receiptsUpdated: number;
  txsUpdated: number;
  errors: number;
  aborted?: "invalid_grant" | "no_connection";
}

export interface BackfillReport {
  dryRun: boolean;
  totals: {
    total: number;
    fetched: number;
    receiptsUpdated: number;
    txsUpdated: number;
    errors: number;
  };
  perUser: UserStats[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function backfillUser(
  userId: number,
  opts: Required<Omit<BackfillOptions, "userId">>,
): Promise<UserStats> {
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
    stats.aborted = "no_connection";
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
    { userId, total: pending.length, dryRun: opts.dryRun, event: "backfill_user_start" },
    "starting backfill for user",
  );

  for (let i = 0; i < pending.length; i += opts.batchSize) {
    const batch = pending.slice(i, i + opts.batchSize);

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

        if (opts.dryRun) {
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
          stats.aborted = "invalid_grant";
          return stats;
        }
        log.error(
          { err, userId, receiptId: receipt.id, event: "fetch_failed" },
          "failed to refetch this receipt; continuing",
        );
      }
    }

    if (i + opts.batchSize < pending.length) await sleep(opts.sleepMs);
  }

  return stats;
}

export async function backfillEmailReceivedAt(
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const opts = {
    dryRun: options.dryRun ?? false,
    batchSize: options.batchSize ?? 25,
    sleepMs: options.sleepMs ?? 200,
  };

  log.info(
    { ...opts, userIdFilter: options.userId ?? null, event: "backfill_start" },
    "backfill start",
  );

  const userIds: number[] = options.userId
    ? [options.userId]
    : (
        await db
          .selectDistinct({ userId: emailReceipts.userId })
          .from(emailReceipts)
          .where(isNull(emailReceipts.emailReceivedAt))
      ).map((r) => r.userId);

  const totals = { total: 0, fetched: 0, receiptsUpdated: 0, txsUpdated: 0, errors: 0 };
  const perUser: UserStats[] = [];

  if (userIds.length === 0) {
    log.info({ event: "nothing_to_backfill" }, "no receipts with NULL email_received_at");
    return { dryRun: opts.dryRun, totals, perUser };
  }

  for (const uid of userIds) {
    const s = await backfillUser(uid, opts);
    log.info(
      {
        userId: s.userId,
        total: s.total,
        fetched: s.fetched,
        receiptsUpdated: s.receiptsUpdated,
        txsUpdated: s.txsUpdated,
        errors: s.errors,
        aborted: s.aborted,
        event: "backfill_user_done",
      },
      "user backfill complete",
    );
    perUser.push(s);
    totals.total += s.total;
    totals.fetched += s.fetched;
    totals.receiptsUpdated += s.receiptsUpdated;
    totals.txsUpdated += s.txsUpdated;
    totals.errors += s.errors;
  }

  log.info(
    { ...totals, dryRun: opts.dryRun, event: "backfill_complete" },
    "backfill complete across all users",
  );

  return { dryRun: opts.dryRun, totals, perUser };
}
