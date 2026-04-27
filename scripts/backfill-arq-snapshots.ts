// #562(c): Backfill account_snapshots from arq_statement_imports.
//
// For each reconciled ARQ statement import, writes a snapshot row anchoring
// the opening balance (declaredStartCents) at periodStart. This lets
// derivedBalanceCentsSql (#562c) show the correct real balance for ARQ
// Ahorros (USD) accounts instead of "$0 + delta".
//
// Invocation:
//   bun run backfill:arq-snapshots
//   bun run backfill:arq-snapshots --dry-run
//   bun run backfill:arq-snapshots --user-id=1
//   bun run backfill:arq-snapshots --user-id=1 --dry-run
//
// Flags:
//   --dry-run      Print what would be inserted without writing anything.
//   --user-id=N    Restrict to a single user (optional; defaults to all users).
//
// Idempotent: uses ON CONFLICT DO UPDATE — safe to re-run. If a snapshot was
// already written by a forward-write (from run-statement-import.ts), the row
// is overwritten with the same value (no net change).
//
// One snapshot per statement period: unlike the original exploration notes
// (earliest-only), we write ONE snapshot per period_start so that the latest
// snapshot always anchors the balance correctly even if intermediate periods
// are later reimported with amended figures.

import { and, eq, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { accountSnapshots, arqStatementImports } from "../src/lib/db/schema";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-arq-snapshots" });

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
    log.warn({ arg, event: "backfill_arq_snapshots_unknown_arg" }, "unknown flag — ignored");
  }
  return { dryRun, userId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dryRun, userId } = parseArgs(process.argv);

  log.info(
    { dryRun, userId, event: "backfill_arq_snapshots_start" },
    dryRun ? "DRY RUN — no writes will be performed" : "starting backfill",
  );

  // Fetch all reconciled ARQ statement imports, optionally scoped to one user.
  const where =
    userId !== null
      ? and(eq(arqStatementImports.userId, userId), eq(arqStatementImports.reconciled, true))
      : eq(arqStatementImports.reconciled, true);

  const imports = await db.query.arqStatementImports.findMany({
    where,
    columns: {
      id: true,
      userId: true,
      accountId: true,
      periodStart: true,
      declaredStartCents: true,
    },
  });

  if (imports.length === 0) {
    log.info({ event: "backfill_arq_snapshots_noop" }, "no reconciled arq_statement_imports found");
    await db.$client.end({ timeout: 1 });
    return;
  }

  log.info(
    { count: imports.length, event: "backfill_arq_snapshots_found" },
    "reconciled imports to process",
  );

  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const imp of imports) {
    const snapshotDate = imp.periodStart; // already YYYY-MM-DD string
    const balanceCents = imp.declaredStartCents;
    const metadata = { source: "arq_statement_backfill", importId: imp.id };

    log.info(
      {
        importId: imp.id,
        userId: imp.userId,
        accountId: imp.accountId,
        snapshotDate,
        balanceCents: balanceCents.toString(),
        event: "backfill_arq_snapshots_row",
      },
      dryRun ? "[dry-run] would upsert snapshot" : "upserting snapshot",
    );

    if (dryRun) continue;

    try {
      // Check if the row already exists to distinguish insert vs update in logging.
      const existing = await db.query.accountSnapshots.findFirst({
        where: and(
          eq(accountSnapshots.accountId, imp.accountId),
          eq(accountSnapshots.snapshotDate, snapshotDate),
        ),
        columns: { id: true },
      });

      await db
        .insert(accountSnapshots)
        .values({
          userId: imp.userId,
          accountId: imp.accountId,
          snapshotDate,
          balanceCents,
          metadata,
        })
        .onConflictDoUpdate({
          target: [accountSnapshots.accountId, accountSnapshots.snapshotDate],
          set: {
            balanceCents: sql`excluded.balance_cents`,
            metadata: sql`excluded.metadata`,
          },
        });

      if (existing) {
        updated += 1;
      } else {
        inserted += 1;
      }
    } catch (err) {
      log.error(
        {
          importId: imp.id,
          userId: imp.userId,
          accountId: imp.accountId,
          snapshotDate,
          err,
          event: "backfill_arq_snapshots_error",
        },
        "failed to upsert snapshot — continuing",
      );
      errors += 1;
    }
  }

  log.info(
    {
      dryRun,
      total: imports.length,
      inserted,
      updated,
      errors,
      event: "backfill_arq_snapshots_done",
    },
    dryRun ? "DRY RUN complete" : "backfill complete",
  );

  await db.$client.end({ timeout: 1 });

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error({ err, event: "backfill_arq_snapshots_fatal" }, "backfill-arq-snapshots failed");
  process.exit(1);
});
