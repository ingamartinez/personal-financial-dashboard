import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";

export function isStrictOneToOne(
  row: { csv_id: number; live_id: number },
  csvCounts: ReadonlyMap<number, number>,
  liveCounts: ReadonlyMap<number, number>,
): boolean {
  return csvCounts.get(row.csv_id) === 1 && liveCounts.get(row.live_id) === 1;
}

export async function collapseCsvCandidate(
  database: typeof db,
  row: {
    csv_id: number;
    live_id: number;
    user_id: number;
    account_id: number;
    live_source: "gmail_bancolombia" | "sms";
    statement_import_id: number | null;
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    const [csv] = await tx.execute<{ raw_data: Record<string, unknown> | null }>(sql`
      SELECT raw_data FROM transactions
      WHERE id = ${row.csv_id} AND user_id = ${row.user_id}
        AND account_id = ${row.account_id} AND source = 'csv_reconcile' AND deleted_at IS NULL
    `);
    const [live] = await tx.execute<{ id: number }>(sql`
      SELECT id FROM transactions
      WHERE id = ${row.live_id} AND user_id = ${row.user_id}
        AND account_id = ${row.account_id} AND source = ${row.live_source}
        AND deleted_at IS NULL AND statement_import_id IS NULL
    `);
    if (!csv || !live) return;
    await tx.execute(sql`
      UPDATE transactions
      SET reconciliation_status = 'matched', reconciled_at = now(),
          statement_import_id = ${row.statement_import_id},
          raw_data = jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{merged_csv_reconcile}',
            ${JSON.stringify({ csv_transaction_id: row.csv_id, csv_raw_data: csv.raw_data })}::jsonb),
          updated_at = now()
      WHERE id = ${row.live_id} AND user_id = ${row.user_id}
        AND deleted_at IS NULL AND statement_import_id IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO reconciliation_decisions (user_id, txn_id, action, merged_into_txn_id, note)
      VALUES (${row.user_id}, ${row.live_id}, 'merged_into', ${row.csv_id},
        ${`#921 CSV reconciliation cross-source dedup; live ${row.live_source} winner`})
    `);
    await tx.execute(sql`
      UPDATE transactions SET deleted_at = now(), updated_at = now()
      WHERE id = ${row.csv_id} AND user_id = ${row.user_id}
        AND account_id = ${row.account_id} AND source = 'csv_reconcile' AND deleted_at IS NULL
    `);
  });
}
