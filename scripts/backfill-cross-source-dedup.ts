// #945: repair the historical #942 cross-source pairs.
//
// Safe by default: without --apply this only reports exact, unambiguous pairs.
// Same-source duplicates and CSV reconciliation rows are deliberately untouched.
// The historical Gmail/SMS merge intentionally does not calculate
// source-mismatch metadata: its SQL scope only admits exact source/amount/date
// candidates, unlike the broader live matcher.

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  findTelegramCandidate,
  retireTelegramIntoStatement,
} from "../src/lib/ingestion/arq-statement/reconciler";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-cross-source-dedup" });

function parseArgs(argv: string[]): { apply: boolean; userId: number | null } {
  let apply = false;
  let userId: number | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") apply = true;
    else {
      const match = arg.match(/^--user-id=(\d+)$/);
      if (match) userId = Number(match[1]);
      else log.warn({ arg, event: "cross_source_dedup_unknown_arg" }, "unknown flag — ignored");
    }
  }
  return { apply, userId };
}

type PairRow = {
  primary_id: number;
  secondary_id: number;
  user_id: number;
  account_id: number;
  primary_occurred_at: Date | string;
  primary_amount_cents: string;
  primary_merchant: string | null;
  secondary_merchant: string | null;
  import_id?: number | null;
};

async function mergeGmailSms(row: PairRow): Promise<void> {
  await db.transaction(async (tx) => {
    const [gmail] = await tx.execute<{ raw_data: Record<string, unknown> | null }>(sql`
      SELECT raw_data FROM transactions
      WHERE id = ${row.primary_id} AND user_id = ${row.user_id}
        AND source = 'gmail_bancolombia' AND deleted_at IS NULL
    `);
    const [sms] = await tx.execute<{ raw_data: Record<string, unknown> | null }>(sql`
      SELECT raw_data FROM transactions
      WHERE id = ${row.secondary_id} AND user_id = ${row.user_id}
        AND account_id = ${row.account_id} AND source = 'sms' AND deleted_at IS NULL
    `);
    if (!gmail || !sms) return;

    await tx.execute(sql`
      UPDATE transactions
      SET secondary_source = 'sms',
          raw_data = jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{merged_sms}',
            ${JSON.stringify({ sms_transaction_id: row.secondary_id, sms_raw_data: sms.raw_data })}::jsonb),
          updated_at = now()
      WHERE id = ${row.primary_id} AND user_id = ${row.user_id} AND deleted_at IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO reconciliation_decisions (user_id, txn_id, action, merged_into_txn_id, note)
      VALUES (${row.user_id}, ${row.primary_id}, 'merged_into', ${row.secondary_id},
        '#921 gmail_bancolombia ↔ sms cross-source dedup; gmail_bancolombia winner')
    `);
    await tx.execute(sql`
      UPDATE transactions SET deleted_at = now(), updated_at = now()
      WHERE id = ${row.secondary_id} AND user_id = ${row.user_id}
        AND account_id = ${row.account_id} AND source = 'sms' AND deleted_at IS NULL
    `);
  });
}

async function main(): Promise<void> {
  const { apply, userId } = parseArgs(process.argv);
  const gmailSmsRows = await db.execute<PairRow>(sql`
    SELECT g.id AS primary_id, s.id AS secondary_id, g.user_id, g.account_id,
           g.occurred_at AS primary_occurred_at,
           g.amount_cents::text AS primary_amount_cents,
           g.merchant AS primary_merchant, s.merchant AS secondary_merchant
    FROM transactions g
    JOIN transactions s ON s.user_id = g.user_id AND s.account_id = g.account_id
      AND s.source = 'sms' AND s.deleted_at IS NULL
      AND s.amount_cents = g.amount_cents
      AND s.occurred_at BETWEEN g.occurred_at - interval '5 minutes'
                            AND g.occurred_at + interval '5 minutes'
    WHERE g.source = 'gmail_bancolombia' AND g.deleted_at IS NULL
      AND g.secondary_source IS NULL
      ${userId === null ? sql`` : sql`AND g.user_id = ${userId}`}
    ORDER BY g.user_id, g.occurred_at, g.id
  `);

  let merged = 0;
  let skipped = 0;
  const anomalies = 0;
  const processedGmailIds = new Set<number>();
  const gmailIdsWithMultipleMatches = new Set<number>();
  const smsIdsWithMultipleMatches = new Set<number>();
  for (const row of gmailSmsRows) {
    if (gmailSmsRows.filter((candidate) => candidate.primary_id === row.primary_id).length > 1) {
      gmailIdsWithMultipleMatches.add(row.primary_id);
    }
    if (
      gmailSmsRows.filter((candidate) => candidate.secondary_id === row.secondary_id).length > 1
    ) {
      smsIdsWithMultipleMatches.add(row.secondary_id);
    }
  }
  for (const row of gmailSmsRows) {
    if (
      gmailIdsWithMultipleMatches.has(row.primary_id) ||
      smsIdsWithMultipleMatches.has(row.secondary_id)
    ) {
      skipped++;
      continue;
    }
    if (processedGmailIds.has(row.primary_id)) {
      skipped++;
      continue;
    }
    processedGmailIds.add(row.primary_id);
    log.info(
      { ...row, apply, event: "gmail_sms_candidate" },
      apply
        ? "merging historical Gmail/SMS duplicate"
        : "[dry-run] would merge historical Gmail/SMS duplicate",
    );
    if (apply) await mergeGmailSms(row);
    merged++;
  }

  const statementRows = await db.execute<PairRow>(sql`
    SELECT s.id AS primary_id, 0 AS secondary_id, s.user_id, s.account_id,
           s.occurred_at AS primary_occurred_at,
           s.amount_cents::text AS primary_amount_cents,
           s.merchant AS primary_merchant, NULL AS secondary_merchant,
           s.arq_statement_import_id AS import_id
    FROM transactions s
    WHERE s.source = 'arq_statement' AND s.deleted_at IS NULL
      AND s.secondary_source IS NULL
      ${userId === null ? sql`` : sql`AND s.user_id = ${userId}`}
    ORDER BY s.user_id, s.occurred_at, s.id
  `);

  const processedTelegramIds = new Set<number>();
  for (const row of statementRows) {
    const match = await findTelegramCandidate(
      db,
      row.user_id,
      row.account_id,
      new Date(row.primary_occurred_at),
      BigInt(row.primary_amount_cents),
      row.primary_merchant,
    );
    if (!match || match.ambiguous) {
      if (match?.ambiguous) skipped++;
      continue;
    }
    if (processedTelegramIds.has(match.tx.id)) {
      skipped++;
      continue;
    }
    processedTelegramIds.add(match.tx.id);
    log.info(
      { ...row, telegramId: match.tx.id, apply, event: "statement_telegram_candidate" },
      apply
        ? "merging historical statement/Telegram duplicate"
        : "[dry-run] would merge historical statement/Telegram duplicate",
    );
    if (apply) {
      await retireTelegramIntoStatement(db, {
        userId: row.user_id,
        accountId: row.account_id,
        telegramTxId: match.tx.id,
        statementTxId: row.primary_id,
        importId: row.import_id ?? 0,
      });
    }
    merged++;
  }

  log.info(
    {
      apply,
      candidates: gmailSmsRows.length + statementRows.length,
      merged,
      skipped,
      anomalies,
      event: "cross_source_dedup_summary",
    },
    "cross-source dedup backfill complete",
  );
  await db.$client.end({ timeout: 1 });
  if (anomalies > 0) process.exit(1);
}

main().catch((err) => {
  log.error({ err, event: "cross_source_dedup_fatal" }, "cross-source dedup backfill failed");
  process.exit(1);
});
