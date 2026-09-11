// #921 Part B: repair gmail_arq rows whose merchant is the account owner's greeting.
//
// Re-parse the original ARQ email to recover the counterparty. The statement
// reconciler may not have paired these rows with their statement counterparts.

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { resolveCounterpartyByKey } from "../src/lib/ingestion/sms-pipeline";
import { normalizeName } from "../src/lib/counterparties/alias-key";
import { canonicalizeMerchant } from "../src/lib/insights/merchant-canonical";
import { parseArqEmail } from "../src/lib/gmail/parsers/arq";
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
    occurred_at: Date;
    raw_html: string;
  }>(sql`
    SELECT
      t.id,
      t.user_id,
      t.merchant,
      t.amount_cents,
      t.occurred_at,
      er.raw_html
    FROM transactions t
    JOIN email_receipts er
      ON er.id = (t.raw_data->>'email_receipt_id')::int
     AND er.user_id = t.user_id
     AND er.deleted_at IS NULL
    WHERE t.source = 'gmail_arq'
      AND t.deleted_at IS NULL
      AND t.merchant ~* '^hi\\s+'
      ${userId === null ? sql`` : sql`AND t.user_id = ${userId}`}
    ORDER BY t.user_id, t.id
  `);

  log.info({ count: rows.length, dryRun, event: "backfill_arq_greeting_found" }, "rows to repair");
  if (userId === null && rows.length !== 0 && rows.length !== 11) {
    log.warn(
      {
        expected: 11,
        found: rows.length,
        event: "backfill_arq_greeting_count_unexpected",
      },
      "unexpected number of greeting rows — continuing with per-row safeguards",
    );
  }
  let repaired = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const parsed = parseArqEmail(row.raw_html, { occurredAt: row.occurred_at });
      if (parsed.kind !== "parsed" || parsed.counterpartyName.trim() === "") {
        log.warn(
          {
            txId: row.id,
            userId: row.user_id,
            parseKind: parsed.kind,
            reason: parsed.kind === "parsed" ? "empty_counterparty_name" : parsed.reason,
            event: "backfill_arq_greeting_parse_skipped",
          },
          "could not recover ARQ counterparty — skipping for manual review",
        );
        skipped += 1;
        continue;
      }

      const counterpartyName = parsed.counterpartyName.trim();
      const normalizedName = normalizeName(counterpartyName);
      if (dryRun) {
        log.info(
          {
            txId: row.id,
            oldMerchant: row.merchant,
            newMerchant: counterpartyName,
            event: "backfill_arq_greeting_dry_run",
          },
          "[dry-run] would repair greeting counterparty",
        );
        repaired += 1;
        continue;
      }

      const cp = await resolveCounterpartyByKey(
        row.user_id,
        { kind: "name", value: normalizedName, initialDisplayName: counterpartyName },
        db,
      );
      if (cp.counterpartyId === null)
        throw new Error(`counterparty resolution returned null for tx ${row.id}`);

      await db.execute(sql`
        UPDATE transactions
        SET merchant = ${counterpartyName},
            canonical_merchant = ${canonicalizeMerchant(counterpartyName)},
            description_raw = CASE
              WHEN raw_data->>'kind' = 'transfer_received'
                THEN 'You received ' || abs(amount_cents)::text || ' USDc from ' || ${counterpartyName}
              ELSE 'You sent USDc to ' || ${counterpartyName}
            END,
            raw_data = jsonb_set(
              raw_data,
              '{arq,recipient_name}',
              to_jsonb(${counterpartyName}::text),
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
      repaired += 1;
    } catch (err) {
      errors += 1;
      log.error(
        { err, txId: row.id, userId: row.user_id, event: "backfill_arq_greeting_row_failed" },
        "failed to repair greeting counterparty — continuing",
      );
    }
  }
  log.info(
    { dryRun, repaired, skipped, errors, event: "backfill_arq_greeting_summary" },
    "greeting counterparty backfill complete",
  );
  await db.$client.end({ timeout: 1 });
  if (errors > 0 || skipped > 0) process.exit(1);
}

main().catch((err) => {
  log.error({ err, event: "backfill_arq_greeting_fatal" }, "greeting counterparty backfill failed");
  process.exit(1);
});
