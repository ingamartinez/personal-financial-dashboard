// #518: one-shot / re-runnable script that retroactively pairs historical
// intra-user transfer transactions that were ingested before the pairing
// logic existed.
//
// Heuristic targets:
//   - transfer_sent/transfer_received pairs in Bancolombia accounts (same user,
//     opposite sign, same currency, different account, within ±24h window).
//   - ARQ transfer_sent (USD) ↔ Bancolombia transfer_received (COP from PEXTO)
//     cross-currency pairs where the cop_amount_cents metadata is available.
//
// Idempotent: only processes tx rows where `transfer_group_id IS NULL` AND
// the pair logic finds a match. Re-running is safe — already-grouped txs skip
// automatically (the pairer's guard returns early for txs with a group id).
//
// Flags:
//   --dry-run    Print what would be paired without writing to the DB.
//   --user-id=N  Scope to a single user (default: all users).
//
// Relative imports — this file is overlaid to $STAGE/scripts/ on prod deploys.
// Keep imports relative and track overlay in deploy.yml (memory: deploy-overlay-must-track-script-imports).

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";
import { pairIntraUserTransfer } from "../src/lib/transfers/intra-user-pair";

const log = createLogger({ module: "migrate-intrauser-transfers-to-group" });

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { dryRun: boolean; userId: number | null } {
  const args = process.argv.slice(2);
  let dryRun = false;
  let userId: number | null = null;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--user-id=")) {
      const raw = arg.slice("--user-id=".length);
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        log.error({ arg, event: "migrate_invalid_user_id" }, "invalid --user-id value");
        process.exit(1);
      }
      userId = parsed;
    }
  }

  return { dryRun, userId };
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type CandidateTx = {
  id: number;
  user_id: number;
  account_id: number;
  amount_cents: string; // postgres.js returns bigint as string
  currency: "COP" | "USD";
  occurred_at: string;
  merchant: string | null;
  raw_data: Record<string, unknown> | null;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export type MigrationReport = {
  scanned: number;
  paired: number;
  skipped: number;
  errors: number;
};

export async function migrateIntraUserTransfers(opts: {
  dryRun: boolean;
  userId: number | null;
}): Promise<MigrationReport> {
  const { dryRun, userId } = opts;

  log.info(
    { dryRun, userId, event: "migrate_start" },
    "starting intra-user transfer pairing migration",
  );

  // Fetch candidate txs: those with transfer-like categorySlug and no group id.
  // We also pick up source=gmail_arq/arq_statement transfer txs that have no
  // categorySlug (ARQ txs aren't classified) but channel='transfer'.
  const userFilter = userId !== null ? sql`AND t.user_id = ${userId}` : sql``;

  const rows = await db.execute<CandidateTx>(sql`
    SELECT
      t.id,
      t.user_id,
      t.account_id,
      t.amount_cents::text as amount_cents,
      t.currency,
      t.occurred_at::text as occurred_at,
      t.merchant,
      t.raw_data
    FROM transactions t
    WHERE
      t.transfer_group_id IS NULL
      AND t.deleted_at IS NULL
      AND (
        -- Same-currency transfer candidates from Bancolombia
        t.category_slug IN ('transferencias', 'ingresos')
        OR
        -- ARQ transfer txs (no category, channel=transfer)
        (t.source IN ('gmail_arq', 'arq_statement') AND t.channel = 'transfer')
      )
      ${userFilter}
    ORDER BY t.user_id, t.occurred_at
  `);

  log.info(
    { count: rows.length, dryRun, event: "migrate_candidates_loaded" },
    "loaded candidate transactions",
  );

  let paired = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const amountCents = BigInt(row.amount_cents);
      const occurredAt = new Date(row.occurred_at);

      if (dryRun) {
        log.info(
          {
            txId: row.id,
            userId: row.user_id,
            accountId: row.account_id,
            amountCents: row.amount_cents,
            currency: row.currency,
            occurredAt: row.occurred_at,
            event: "migrate_dry_run_candidate",
          },
          "[dry-run] would attempt pairing",
        );
        skipped++;
        continue;
      }

      const result = await pairIntraUserTransfer(
        {},
        {
          id: row.id,
          userId: row.user_id,
          accountId: row.account_id,
          channel: "transfer",
          amountCents,
          currency: row.currency,
          occurredAt,
          counterparty: row.merchant,
          rawData: row.raw_data,
        },
      );

      if (result.groupId !== null) {
        log.info(
          {
            txId: row.id,
            userId: row.user_id,
            pairedTxId: result.pairedTxId,
            groupId: result.groupId,
            event: "migrate_paired",
          },
          "paired intra-user transfer",
        );
        paired++;
      } else {
        skipped++;
      }
    } catch (err) {
      log.error(
        { err, txId: row.id, userId: row.user_id, event: "migrate_error" },
        "error processing candidate tx",
      );
      errors++;
    }
  }

  const report: MigrationReport = {
    scanned: rows.length,
    paired,
    skipped,
    errors,
  };

  log.info(
    { ...report, dryRun, event: "migrate_done" },
    "intra-user transfer pairing migration complete",
  );

  return report;
}

// ---------------------------------------------------------------------------
// Entry point (script mode)
// ---------------------------------------------------------------------------

const { dryRun, userId } = parseArgs();
migrateIntraUserTransfers({ dryRun, userId })
  .then((report) => {
    log.info({ ...report, event: "migrate_exit" }, "migration finished");
    process.exit(0);
  })
  .catch((err) => {
    log.error({ err, event: "migrate_fatal" }, "migration failed with unhandled error");
    process.exit(1);
  });
