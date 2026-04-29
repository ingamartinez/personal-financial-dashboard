// #637: Backfill counterparty_id on existing email_arq transactions.
//
// For each tx with source='gmail_arq' and counterparty_id IS NULL, resolves
// (or creates) a counterparty via the same resolveCounterpartyByKey used at
// ingest time and writes it back via UPDATE. Idempotent — re-running does not
// duplicate counterparties (alias uniqueIndex guards that).
//
// Invocation:
//   bun run backfill:email-arq-counterparties
//   bun run backfill:email-arq-counterparties --dry-run
//   bun run backfill:email-arq-counterparties --user-id=1
//   bun run backfill:email-arq-counterparties --user-id=1 --dry-run
//
// Flags:
//   --dry-run      Log what WOULD be done without writing anything.
//                  In dry-run mode the resolveCounterpartyByKey call is
//                  skipped entirely — the lookup is read-only but would still
//                  increment hit_count; we avoid that side-effect.
//   --user-id=N    Restrict to a single user (optional; defaults to all users).

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { resolveCounterpartyByKey } from "../src/lib/ingestion/sms-pipeline";
import { normalizeName } from "../src/lib/counterparties/alias-key";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-email-arq-counterparties" });

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dryRun: boolean; userId: number | null } {
  let dryRun = false;
  let userId: number | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const m = arg.match(/^--user-id=(\d+)$/);
    if (m) {
      userId = Number(m[1]);
      continue;
    }
    log.warn({ arg, event: "backfill_arq_cp_unknown_arg" }, "unknown flag — ignored");
  }
  return { dryRun, userId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dryRun, userId } = parseArgs(process.argv);

  log.info(
    { dryRun, userId, event: "backfill_arq_cp_start" },
    dryRun ? "DRY RUN — no writes will be performed" : "starting backfill",
  );

  // Walk transactions with source='gmail_arq' and counterparty_id IS NULL.
  // Soft-delete guard: deleted_at IS NULL.
  // Optionally restrict to a single user for targeted runs.
  const rows = await db.execute<{
    id: number;
    user_id: number;
    merchant: string | null;
  }>(sql`
    SELECT id, user_id, merchant
    FROM transactions
    WHERE source = 'gmail_arq'
      AND counterparty_id IS NULL
      AND deleted_at IS NULL
      ${userId !== null ? sql`AND user_id = ${userId}` : sql``}
    ORDER BY user_id, id
  `);

  if (rows.length === 0) {
    log.info({ event: "backfill_arq_cp_noop" }, "no orphan email_arq transactions found");
    await db.$client.end({ timeout: 1 });
    return;
  }

  log.info(
    { count: rows.length, dryRun, event: "backfill_arq_cp_found" },
    "orphan transactions to process",
  );

  // Per-user counters for summary logging.
  const byUser: Record<number, { processed: number; skipped: number; errors: number }> = {};
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const row of rows) {
    if (!byUser[row.user_id]) {
      byUser[row.user_id] = { processed: 0, skipped: 0, errors: 0 };
    }
    const counters = byUser[row.user_id];

    // Skip rows where merchant is null or empty — we have nothing to key on.
    if (!row.merchant || row.merchant.trim() === "") {
      log.warn(
        { txId: row.id, userId: row.user_id, event: "backfill_arq_cp_no_merchant" },
        "tx has no merchant — skipping",
      );
      counters.skipped += 1;
      totalSkipped += 1;
      continue;
    }

    const normalizedName = normalizeName(row.merchant);

    if (dryRun) {
      log.info(
        {
          txId: row.id,
          userId: row.user_id,
          merchant: row.merchant,
          normalizedName,
          event: "backfill_arq_cp_dry_run",
        },
        "[dry-run] would resolve counterparty",
      );
      counters.processed += 1;
      totalProcessed += 1;
      continue;
    }

    try {
      const cp = await resolveCounterpartyByKey(
        row.user_id,
        {
          kind: "name",
          value: normalizedName,
          initialDisplayName: row.merchant,
        },
        db,
      );

      if (cp.counterpartyId === null) {
        // Should not happen for kind="name" — resolveCounterpartyByKey always
        // inserts if not found. Log as a warning and skip to avoid null writes.
        log.warn(
          { txId: row.id, userId: row.user_id, event: "backfill_arq_cp_null_result" },
          "resolveCounterpartyByKey returned null — skipping",
        );
        counters.skipped += 1;
        totalSkipped += 1;
        continue;
      }

      // Tenant-safe UPDATE: always include user_id in the WHERE clause.
      await db.execute(sql`
        UPDATE transactions
        SET counterparty_id = ${cp.counterpartyId},
            updated_at = now()
        WHERE id = ${row.id}
          AND user_id = ${row.user_id}
      `);

      log.info(
        {
          txId: row.id,
          userId: row.user_id,
          counterpartyId: cp.counterpartyId,
          merchant: row.merchant,
          event: "backfill_arq_cp_updated",
        },
        "linked counterparty to tx",
      );
      counters.processed += 1;
      totalProcessed += 1;
    } catch (err) {
      log.error(
        {
          txId: row.id,
          userId: row.user_id,
          merchant: row.merchant,
          err,
          event: "backfill_arq_cp_error",
        },
        "failed to resolve/update counterparty — continuing",
      );
      counters.errors += 1;
      totalErrors += 1;
    }
  }

  // Per-user summary.
  for (const [uid, c] of Object.entries(byUser)) {
    log.info(
      {
        userId: Number(uid),
        processed: c.processed,
        skipped: c.skipped,
        errors: c.errors,
        event: "backfill_arq_cp_user_summary",
      },
      dryRun ? "[dry-run] user summary" : "user summary",
    );
  }

  log.info(
    {
      dryRun,
      total: rows.length,
      totalProcessed,
      totalSkipped,
      totalErrors,
      event: "backfill_arq_cp_done",
    },
    dryRun ? "DRY RUN complete" : "backfill complete",
  );

  await db.$client.end({ timeout: 1 });

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error({ err, event: "backfill_arq_cp_fatal" }, "backfill-email-arq-counterparties failed");
  process.exit(1);
});
