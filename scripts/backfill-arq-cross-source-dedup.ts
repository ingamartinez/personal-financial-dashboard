// #921 Part A: retire historical arq_statement duplicates when gmail_arq is the winner.
//
// Safe by default: without --apply this only prints the exact rows that would
// be merged. It deliberately pairs only these two sources; same-source rows and
// every other cross-source pair are untouched. A duplicate SQL join row for one
// email is an expected 1:N protection skip, not an anomaly. This historical
// merge also intentionally does not calculate source-mismatch metadata: its
// SQL scope only admits exact source/amount/date candidates.

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  findExistingStatementMatch,
  mergeExistingStatementIntoEmail,
} from "../src/lib/ingestion/arq-statement/reconciler";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-arq-cross-source-dedup" });

type ArqBackfillRow = {
  email_id: number;
  statement_id: number;
  user_id: number;
  account_id: number;
  email_amount_cents: string;
  email_occurred_at: Date | string;
  email_merchant: string | null;
  statement_merchant: string | null;
};

function parseArgs(argv: string[]): { apply: boolean; userId: number | null } {
  let apply = false;
  let userId: number | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") apply = true;
    else {
      const match = arg.match(/^--user-id=(\d+)$/);
      if (match) userId = Number(match[1]);
      else log.warn({ arg, event: "arq_dedup_unknown_arg" }, "unknown flag — ignored");
    }
  }
  return { apply, userId };
}

async function main(): Promise<void> {
  const { apply, userId } = parseArgs(process.argv);
  const rows = await db.execute<ArqBackfillRow>(sql`
    SELECT
      e.id AS email_id,
      s.id AS statement_id,
      e.user_id,
      e.account_id,
      e.amount_cents::text AS email_amount_cents,
      e.occurred_at AS email_occurred_at,
      e.merchant AS email_merchant,
      s.merchant AS statement_merchant
    FROM transactions e
    JOIN transactions s
      ON s.user_id = e.user_id
     AND s.account_id = e.account_id
     AND s.source = 'arq_statement'
     AND s.deleted_at IS NULL
      AND sign(s.amount_cents) = sign(e.amount_cents)
      AND abs(s.amount_cents - e.amount_cents) <= 10
     AND s.occurred_at BETWEEN e.occurred_at - interval '24 hours'
                           AND e.occurred_at + interval '24 hours'
    WHERE e.source = 'gmail_arq'
      AND e.deleted_at IS NULL
      AND e.secondary_source IS NULL
      ${userId === null ? sql`` : sql`AND e.user_id = ${userId}`}
    ORDER BY e.user_id, e.occurred_at, e.id
  `);

  let merged = 0;
  let skipped = 0;
  let anomalies = 0;
  const rowsByEmail = new Map<number, ArqBackfillRow[]>();
  for (const row of rows) {
    const emailRows = rowsByEmail.get(row.email_id) ?? [];
    emailRows.push(row);
    rowsByEmail.set(row.email_id, emailRows);
  }
  for (const emailRows of rowsByEmail.values()) {
    const row = emailRows[0];
    const statementId = await findExistingStatementMatch(
      {},
      {
        userId: row.user_id,
        accountId: row.account_id,
        emailAmountCents: BigInt(row.email_amount_cents),
        emailOccurredAt: new Date(row.email_occurred_at),
        emailMerchant: row.email_merchant,
      },
    );
    const matchedRow = emailRows.find((candidate) => candidate.statement_id === statementId);
    if (!matchedRow) {
      skipped += 1;
      anomalies += 1;
      log.warn(
        {
          emailTxId: row.email_id,
          expectedStatementTxIds: emailRows.map((candidate) => candidate.statement_id),
          actualStatementTxId: statementId,
          event: "arq_dedup_pair_changed",
        },
        "candidate no longer resolves to the same unique statement row — skipping",
      );
      continue;
    }
    log.info(
      {
        userId: row.user_id,
        accountId: row.account_id,
        emailTxId: row.email_id,
        statementTxId: matchedRow.statement_id,
        emailMerchant: row.email_merchant,
        statementMerchant: row.statement_merchant,
        apply,
        event: "arq_dedup_candidate",
      },
      apply
        ? "merging historical ARQ cross-source duplicate"
        : "[dry-run] would merge historical ARQ cross-source duplicate",
    );
    if (apply) {
      await mergeExistingStatementIntoEmail(
        {},
        {
          userId: row.user_id,
          accountId: row.account_id,
          emailTxId: row.email_id,
          statementTxId: matchedRow.statement_id,
          emailAmountCents: BigInt(row.email_amount_cents),
          emailOccurredAt: new Date(row.email_occurred_at),
          emailMerchant: row.email_merchant,
        },
      );
    }
    merged += 1;
  }
  log.info(
    { apply, candidates: rows.length, merged, skipped, anomalies, event: "arq_dedup_summary" },
    "ARQ cross-source dedup backfill complete",
  );
  await db.$client.end({ timeout: 1 });
  if (anomalies > 0) process.exit(1);
}

main().catch((err) => {
  log.error({ err, event: "arq_dedup_fatal" }, "ARQ cross-source dedup backfill failed");
  process.exit(1);
});
