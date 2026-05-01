/**
 * Backfill script: populate canonical_merchant for existing transactions.
 *
 * For each non-deleted tx where canonical_merchant IS NULL and merchant IS NOT
 * NULL, compute canonicalizeMerchant(merchant) and write the result.
 *
 * Idempotent: re-running is a no-op for rows already populated
 * (canonical_merchant IS NULL filter handles it; also covers rows where
 * canonical_merchant is legitimately null because merchant is null or
 * matched a skip pattern — those are intentionally excluded from re-processing
 * by including an AND merchant IS NOT NULL guard).
 *
 * CLI flags:
 *   --dry-run           Print what would be updated without writing.
 *   --user-id=N         Only process transactions for user N.
 *   --batch-size=N      Rows per SQL UPDATE (default 200).
 *
 * Usage:
 *   bun scripts/backfill-canonical-merchant.ts
 *   bun scripts/backfill-canonical-merchant.ts --dry-run
 *   bun scripts/backfill-canonical-merchant.ts --user-id=1 --dry-run
 */

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";
import { canonicalizeMerchant } from "../src/lib/insights/merchant-canonical";

const log = createLogger({ module: "backfill-canonical-merchant" });

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((a) => a.startsWith("--user-id="));
const BATCH_SIZE_ARG = args.find((a) => a.startsWith("--batch-size="));

const userId: number | null = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : null;
const batchSize: number = BATCH_SIZE_ARG ? Number(BATCH_SIZE_ARG.split("=")[1]) : 200;

if (userId !== null && (!Number.isFinite(userId) || userId <= 0)) {
  log.error({ userIdArg: USER_ID_ARG }, "--user-id must be a positive integer");
  process.exit(1);
}
if (!Number.isFinite(batchSize) || batchSize <= 0) {
  log.error({ batchSizeArg: BATCH_SIZE_ARG }, "--batch-size must be a positive integer");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface TxRow {
  id: number;
  user_id: number;
  merchant: string;
}

async function main() {
  log.info(
    {
      dryRun: DRY_RUN,
      userId: userId ?? "all",
      batchSize,
      event: "backfill_canonical_merchant_start",
    },
    "starting canonical-merchant backfill",
  );

  // Fetch non-deleted rows where merchant is set but canonical_merchant has not
  // been populated yet. The IS NULL guard makes this idempotent: rows that were
  // already written (canonical_merchant != NULL) are excluded on re-run.
  // Rows where merchant is NULL are also excluded — nothing to canonicalize.
  const userFilter = userId !== null ? sql`AND user_id = ${userId}` : sql``;

  const rawRows = await db.execute(sql`
    SELECT id, user_id, merchant
    FROM transactions
    WHERE deleted_at IS NULL
      AND merchant IS NOT NULL
      AND canonical_merchant IS NULL
    ${userFilter}
    ORDER BY id
  `);
  const rows = rawRows as unknown as TxRow[];

  if (rows.length === 0) {
    log.info(
      { event: "backfill_canonical_merchant_noop" },
      "No transactions need backfill; nothing to do.",
    );
    return;
  }

  log.info(
    { totalRows: rows.length, event: "backfill_canonical_merchant_fetched" },
    `Fetched ${rows.length} transactions to process`,
  );

  // Compute canonical values; collect only rows where the result is non-null.
  // Rows where canonicalizeMerchant returns null (skip patterns) are intentionally
  // left with canonical_merchant = NULL — that is the correct stored value.
  const toUpdate: Array<{ id: number; canonical: string }> = [];
  let skippedNull = 0;

  for (const row of rows) {
    const canonical = canonicalizeMerchant(row.merchant);
    if (canonical === null) {
      skippedNull++;
      continue; // skip patterns → canonical_merchant stays NULL
    }
    toUpdate.push({ id: row.id, canonical });
  }

  log.info(
    {
      skippedNull,
      toUpdate: toUpdate.length,
      dryRun: DRY_RUN,
      event: "backfill_canonical_merchant_plan",
    },
    `${skippedNull} txs have skip-pattern merchants (canonical stays null). ${toUpdate.length} txs need canonical write.`,
  );

  if (toUpdate.length === 0) {
    log.info(
      { event: "backfill_canonical_merchant_done_noop" },
      "Nothing to update after canonicalization.",
    );
    return;
  }

  if (DRY_RUN) {
    log.info(
      { sample: toUpdate.slice(0, 5).map((r) => ({ id: r.id, canonical: r.canonical })) },
      "Dry-run: would update these tx IDs (first 5 shown)",
    );
    log.info(
      { event: "backfill_canonical_merchant_dry_run_done" },
      "Dry-run complete — no writes performed.",
    );
    return;
  }

  // Process in batches using CASE WHEN pattern for efficient multi-row UPDATE.
  let updatedCount = 0;
  for (let i = 0; i < toUpdate.length; i += batchSize) {
    const batch = toUpdate.slice(i, i + batchSize);

    const ids = batch.map((r) => r.id);
    const caseExpr = batch.reduce(
      (acc, r) => sql`${acc} WHEN id = ${r.id} THEN ${r.canonical}`,
      sql``,
    );

    await db.execute(sql`
      UPDATE transactions
      SET canonical_merchant = CASE ${caseExpr} ELSE canonical_merchant END,
          updated_at = now()
      WHERE id = ANY(ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::integer[])
    `);

    updatedCount += batch.length;
    log.info(
      {
        batch: i / batchSize + 1,
        updatedCount,
        total: toUpdate.length,
        event: "backfill_canonical_merchant_batch",
      },
      `Batch done: ${updatedCount}/${toUpdate.length} updated`,
    );
  }

  log.info(
    { updatedCount, event: "backfill_canonical_merchant_done" },
    `Backfill complete: ${updatedCount} transactions updated.`,
  );
}

main().catch((err) => {
  log.error({ err, event: "backfill_canonical_merchant_fatal" }, "Backfill failed");
  process.exit(1);
});
