// #921 Part B: repair gmail_arq rows whose merchant is the account owner's greeting.
//
// The ARQ statement reconciler stores the authoritative statement recipient in
// raw_data.merged_statement.recipient_name_from_statement. This backfill only
// touches known-corrupted, live gmail_arq rows that have that evidence; it does
// not infer matches from same-day/amount collisions.

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { resolveCounterpartyByKey } from "../src/lib/ingestion/sms-pipeline";
import { normalizeName } from "../src/lib/counterparties/alias-key";
import { canonicalizeMerchant } from "../src/lib/insights/merchant-canonical";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-gmail-arq-greeting-counterparties" });

function parseArgs(argv: string[]): { dryRun: boolean; userId: number | null } {
  let dryRun = false;
  let userId: number | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else {
      const match = arg.match(/^--user-id=(\d+)$/);
      if (match) userId = Number(match[1]);
      else log.warn({ arg, event: "backfill_arq_greeting_unknown_arg" }, "unknown flag — ignored");
    }
  }
  return { dryRun, userId };
}

async function main(): Promise<void> {
  const { dryRun, userId } = parseArgs(process.argv);
  const rows = await db.execute<{
    id: number;
    user_id: number;
    merchant: string;
    amount_cents: bigint;
    statement_counterparty: string;
  }>(sql`
    SELECT
      t.id,
      t.user_id,
      t.merchant,
      t.amount_cents,
      t.raw_data->'merged_statement'->>'recipient_name_from_statement' AS statement_counterparty
    FROM transactions t
    WHERE t.source = 'gmail_arq'
      AND t.deleted_at IS NULL
      AND t.merchant ~* '^hi\\s+'
      AND t.raw_data->'merged_statement'->>'recipient_name_from_statement' IS NOT NULL
      ${userId === null ? sql`` : sql`AND t.user_id = ${userId}`}
    ORDER BY t.user_id, t.id
  `);

  log.info({ count: rows.length, dryRun, event: "backfill_arq_greeting_found" }, "rows to repair");
  if (userId === null && rows.length !== 0 && rows.length !== 11) {
    throw new Error(
      `expected exactly 11 known-corrupted rows (or 0 after backfill), found ${rows.length}`,
    );
  }
  let errors = 0;
  for (const row of rows) {
    try {
      const normalizedName = normalizeName(row.statement_counterparty);
      if (dryRun) {
        log.info(
          {
            txId: row.id,
            oldMerchant: row.merchant,
            newMerchant: row.statement_counterparty,
            event: "backfill_arq_greeting_dry_run",
          },
          "[dry-run] would repair greeting counterparty",
        );
        continue;
      }

      const cp = await resolveCounterpartyByKey(
        row.user_id,
        { kind: "name", value: normalizedName, initialDisplayName: row.statement_counterparty },
        db,
      );
      if (cp.counterpartyId === null)
        throw new Error(`counterparty resolution returned null for tx ${row.id}`);

      await db.execute(sql`
        UPDATE transactions
        SET merchant = ${row.statement_counterparty},
            canonical_merchant = ${canonicalizeMerchant(row.statement_counterparty)},
            description_raw = CASE
              WHEN raw_data->>'kind' = 'transfer_received'
                THEN 'You received ' || abs(amount_cents)::text || ' USDc from ' || ${row.statement_counterparty}
              ELSE 'You sent USDc to ' || ${row.statement_counterparty}
            END,
            raw_data = jsonb_set(
              raw_data,
              '{arq,recipient_name}',
              to_jsonb(${row.statement_counterparty}::text),
              true
            ),
            counterparty_id = ${cp.counterpartyId},
            updated_at = now()
        WHERE id = ${row.id}
          AND user_id = ${row.user_id}
          AND source = 'gmail_arq'
          AND deleted_at IS NULL
          AND merchant ~* '^hi\\s+'
      `);
      log.info(
        {
          txId: row.id,
          userId: row.user_id,
          counterpartyId: cp.counterpartyId,
          event: "backfill_arq_greeting_updated",
        },
        "repaired greeting counterparty",
      );
    } catch (err) {
      errors += 1;
      log.error(
        { err, txId: row.id, userId: row.user_id, event: "backfill_arq_greeting_row_failed" },
        "failed to repair greeting counterparty — continuing",
      );
    }
  }
  await db.$client.end({ timeout: 1 });
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  log.error({ err, event: "backfill_arq_greeting_fatal" }, "greeting counterparty backfill failed");
  process.exit(1);
});
