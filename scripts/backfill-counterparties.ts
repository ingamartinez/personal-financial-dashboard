import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { resolveCounterparty } from "../src/app/api/ingest/sms/route";
import { parseSmsBancolombia } from "../src/lib/ingestion/sms-bancolombia";

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
    console.log("Nothing to backfill.");
    return;
  }

  console.log(`Backfilling ${rows.length} tx…`);
  let updated = 0;
  for (const row of rows) {
    const rawSms = row.raw_data?.sms;
    if (!rawSms) {
      console.warn(`tx ${row.id}: no raw_data.sms — skipped`);
      continue;
    }
    const parsed = parseSmsBancolombia(rawSms);
    if (parsed.kind === "skip") {
      console.warn(`tx ${row.id}: parser returned skip:${parsed.reason} — skipped`);
      continue;
    }
    const cp = await resolveCounterparty(parsed, db);
    if (cp.counterpartyId === null) {
      console.warn(`tx ${row.id}: kind=${parsed.kind} has no counterparty — skipped`);
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
  console.log(`Updated ${updated} tx.`);
  await db.$client.end({ timeout: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
