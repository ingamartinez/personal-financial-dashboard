import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { resolveCounterparty } from "../src/lib/ingestion/sms-pipeline";
import { parseSmsBancolombia } from "../src/lib/ingestion/sms-bancolombia";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-counterparties" });

// Backfills counterparty_id on historical tx that were ingested before the
// qr_payment auto-create behavior landed. Re-parses the raw SMS body and
// upserts the counterparty via the same resolveCounterparty used at ingest.

async function main() {
  const rows = await db.execute<{
    id: number;
    raw_data: { kind?: string; sms?: string };
  }>(sql`
    SELECT id, raw_data
    FROM transactions
    WHERE counterparty_id IS NULL
      AND raw_data->>'kind' IN ('qr_payment','bre_b_transfer')
  `);

  if (rows.length === 0) {
    log.info({ event: "backfill_counterparties_noop" }, "Nothing to backfill.");
    return;
  }

  log.info({ count: rows.length, event: "backfill_counterparties_start" }, "Backfilling tx");
  let updated = 0;
  for (const row of rows) {
    const rawSms = row.raw_data?.sms;
    if (!rawSms) {
      log.warn(
        { txId: row.id, event: "backfill_counterparties_missing_sms" },
        "tx has no raw_data.sms — skipped",
      );
      continue;
    }
    const parsed = parseSmsBancolombia(rawSms);
    if (parsed.kind === "skip") {
      log.warn(
        { txId: row.id, reason: parsed.reason, event: "backfill_counterparties_skip_parsed" },
        "parser returned skip — skipped",
      );
      continue;
    }
    // Backfill script runs against the single-user dev DB pre-multi-tenancy
    // data, so user_id=1 is always the right scope.
    const cp = await resolveCounterparty(1, parsed, db);
    if (cp.counterpartyId === null) {
      log.warn(
        { txId: row.id, kind: parsed.kind, event: "backfill_counterparties_no_counterparty" },
        "kind has no counterparty — skipped",
      );
      continue;
    }
    await db.execute(sql`
      UPDATE transactions SET
        counterparty_id = ${cp.counterpartyId},
        category_slug = COALESCE(category_slug, ${cp.inheritedCategory}),
        classification_method = CASE
          WHEN category_slug IS NULL AND ${cp.inheritedCategory}::text IS NOT NULL THEN 'rule'::classification_method
          ELSE classification_method
        END,
        updated_at = now()
      WHERE id = ${row.id}
    `);
    updated += 1;
  }
  log.info({ updated, event: "backfill_counterparties_updated" }, "Updated tx");
  await db.$client.end({ timeout: 1 });
}

main().catch((err) => {
  log.error({ err, event: "backfill_counterparties_failed" }, "backfill-counterparties failed");
  process.exit(1);
});
