/**
 * Backfill script: ensure all transactions have a valid rawData.fx block.
 *
 * For txs missing or with invalid fx metadata, writes a default canonical block:
 *   - tx.currency === COP (COP account): originalCurrency='COP', trmToAccountCurrency=null, trmSource='1_to_1'
 *   - tx.currency === USD (USD account): originalCurrency='USD', trmToAccountCurrency=null, trmSource='1_to_1'
 *   - cross-currency txs with no derivable TRM: trmSource='unknown' (logged)
 *
 * Idempotent: re-running skips txs that already have a valid FxMetadata block.
 *
 * CLI flags:
 *   --dry-run           Print what would be updated without writing.
 *   --user-id=N         Only process transactions for user N.
 *   --batch-size=N      Rows per SQL UPDATE (default 100).
 *
 * Usage:
 *   bun scripts/backfill-fx-metadata.ts
 *   bun scripts/backfill-fx-metadata.ts --dry-run
 *   bun scripts/backfill-fx-metadata.ts --user-id=1 --dry-run
 */

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";
import { parseFxMetadata, type FxMetadata } from "../src/lib/types/fx-metadata";

const log = createLogger({ module: "backfill-fx-metadata" });

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((a) => a.startsWith("--user-id="));
const BATCH_SIZE_ARG = args.find((a) => a.startsWith("--batch-size="));

const userId: number | null = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : null;
const batchSize: number = BATCH_SIZE_ARG ? Number(BATCH_SIZE_ARG.split("=")[1]) : 100;

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
  currency: string;
  amount_cents: bigint;
  raw_data: Record<string, unknown> | null;
}

/**
 * Build a default FxMetadata block for a tx that is missing or has an invalid one.
 * Returns null when the tx is cross-currency with no derivable TRM (trmSource='unknown').
 */
function buildDefaultFx(tx: TxRow): FxMetadata | null {
  const currency = tx.currency;
  const absAmountCents = tx.amount_cents < BigInt(0) ? -tx.amount_cents : tx.amount_cents;

  if (currency === "COP") {
    return {
      originalCurrency: "COP",
      originalAmountCents: absAmountCents.toString(),
      trmToAccountCurrency: null,
      trmSource: "1_to_1",
    };
  }

  if (currency === "USD" || currency === "USDc") {
    return {
      originalCurrency: currency as "USD" | "USDc",
      originalAmountCents: absAmountCents.toString(),
      trmToAccountCurrency: null,
      trmSource: "1_to_1",
    };
  }

  // Unknown / cross-currency — cannot determine TRM without statement data.
  log.warn(
    {
      txId: tx.id,
      currency,
      event: "backfill_fx_unknown_currency",
    },
    "tx has an unsupported currency for automatic fx backfill; marking as unknown",
  );
  return {
    originalCurrency: "COP", // best guess fallback
    originalAmountCents: absAmountCents.toString(),
    trmToAccountCurrency: null,
    trmSource: "unknown",
  };
}

async function main() {
  log.info(
    {
      dryRun: DRY_RUN,
      userId: userId ?? "all",
      batchSize,
      event: "backfill_fx_start",
    },
    "starting fx-metadata backfill",
  );

  // Fetch all transactions that either have no rawData, no fx block, or an
  // invalid fx block. We cannot filter invalid blocks in SQL easily (would
  // need JSON shape validation per-row), so we pull all and check in app code.
  // Performance note: with millions of rows this needs pagination; for current
  // scale (hundreds→thousands) this is fine. Add LIMIT/OFFSET if needed.
  const userFilter = userId !== null ? sql`AND user_id = ${userId}` : sql``;

  const rawRows = await db.execute(sql`
    SELECT id, user_id, currency, amount_cents, raw_data
    FROM transactions
    WHERE deleted_at IS NULL
    ${userFilter}
    ORDER BY id
  `);
  const rows = rawRows as unknown as TxRow[];

  if (rows.length === 0) {
    log.info({ event: "backfill_fx_noop" }, "No transactions found; nothing to backfill.");
    return;
  }

  log.info(
    { totalRows: rows.length, event: "backfill_fx_fetched" },
    `Fetched ${rows.length} transactions to inspect`,
  );

  const toUpdate: Array<{ id: number; rawData: Record<string, unknown> }> = [];
  let alreadyValid = 0;

  for (const row of rows) {
    const rawData = row.raw_data ?? {};
    const existingFx = rawData.fx ?? null;

    // Check if existing fx block is already valid.
    if (existingFx !== null) {
      const parsed = parseFxMetadata(existingFx);
      if (parsed !== null) {
        alreadyValid++;
        continue; // idempotent: skip valid rows
      }
    }

    const defaultFx = buildDefaultFx(row);
    if (defaultFx === null) continue; // should not happen

    const newRawData: Record<string, unknown> = {
      ...rawData,
      fx: defaultFx,
    };
    toUpdate.push({ id: row.id, rawData: newRawData });
  }

  log.info(
    {
      alreadyValid,
      toUpdate: toUpdate.length,
      dryRun: DRY_RUN,
      event: "backfill_fx_plan",
    },
    `${alreadyValid} txs already valid. ${toUpdate.length} txs need backfill.`,
  );

  if (toUpdate.length === 0) {
    log.info({ event: "backfill_fx_done_noop" }, "Nothing to update.");
    return;
  }

  if (DRY_RUN) {
    log.info(
      { sample: toUpdate.slice(0, 5).map((r) => r.id) },
      "Dry-run: would update these tx IDs (first 5 shown)",
    );
    log.info({ event: "backfill_fx_dry_run_done" }, "Dry-run complete — no writes performed.");
    return;
  }

  // Process in batches.
  let updatedCount = 0;
  for (let i = 0; i < toUpdate.length; i += batchSize) {
    const batch = toUpdate.slice(i, i + batchSize);

    // Build a multi-row UPDATE using CASE WHEN … THEN … END pattern.
    // This is more efficient than N individual UPDATEs for large backlogs.
    const ids = batch.map((r) => r.id);
    const caseExpr = batch.reduce(
      (acc, r) => sql`${acc} WHEN id = ${r.id} THEN ${JSON.stringify(r.rawData)}::jsonb`,
      sql``,
    );

    await db.execute(sql`
      UPDATE transactions
      SET raw_data = CASE ${caseExpr} ELSE raw_data END,
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
        event: "backfill_fx_batch",
      },
      `Batch done: ${updatedCount}/${toUpdate.length} updated`,
    );
  }

  log.info(
    { updatedCount, event: "backfill_fx_done" },
    `Backfill complete: ${updatedCount} transactions updated.`,
  );
}

main().catch((err) => {
  log.error({ err, event: "backfill_fx_fatal" }, "Backfill failed");
  process.exit(1);
});
