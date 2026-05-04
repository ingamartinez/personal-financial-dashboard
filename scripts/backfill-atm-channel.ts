/**
 * Backfill script: set channel='cash_withdrawal' for existing ATM withdrawal
 * transactions that were ingested before the #766 fix.
 *
 * BACKGROUND — why this is a script, not a drizzle migration:
 *   When a migration adds a new enum value via ALTER TYPE ADD VALUE, Postgres
 *   requires that value to be committed before it can be referenced in DML.
 *   Running an UPDATE that uses the new value in the same drizzle batch (same
 *   transaction) triggers:
 *     "unsafe use of new value of enum type — new enum values must be committed
 *      before they can be used"
 *   Postgres rejects the whole batch with an error.
 *
 *   In local dev this is invisible because the implementer ran 0077 and 0078
 *   separately via psql (different sessions = different transactions). Drizzle's
 *   migrate() wraps every migration file in a single transaction, but it also
 *   batches multiple files into one call, which can trigger the footgun on a
 *   fresh DB where both migrations run back-to-back.
 *
 *   SOLUTION: any DML backfill that depends on a newly-added enum value MUST
 *   run as a post-migrate script, not as a .sql migration file. The deploy
 *   workflow runs this script immediately after migrate-prod.ts completes.
 *   See #766 hotfix for details.
 *
 * WHAT IT DOES:
 *   UPDATE transactions
 *   SET channel = 'cash_withdrawal'
 *   WHERE description_raw LIKE 'Retiro ATM %'
 *     AND channel = 'bank';
 *
 *   ATM withdrawals were ingested with channel='bank' (the sms-pipeline default)
 *   before #766 added the dedicated cash_withdrawal value. The 'Retiro ATM %'
 *   prefix is produced exclusively by the atm_withdrawal branch of the SMS
 *   pipeline — no other transaction kind generates it.
 *
 * IDEMPOTENT:
 *   The WHERE clause only matches rows still on channel='bank'. Re-running
 *   after the first pass is a no-op (0 rows affected).
 *
 * Usage:
 *   bun run db:backfill:atm
 *   bun scripts/backfill-atm-channel.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-atm-channel" });

async function main() {
  const start = Date.now();

  log.info(
    { event: "backfill_atm_channel_start" },
    "starting ATM channel backfill — setting channel=cash_withdrawal for Retiro ATM rows",
  );

  const result = await db.execute(sql`
    UPDATE transactions
    SET channel = 'cash_withdrawal'
    WHERE description_raw LIKE 'Retiro ATM %'
      AND channel = 'bank'
  `);

  // postgres-js returns rows affected in result.count
  const affected = (result as unknown as { count: number }).count ?? 0;
  const durationMs = Date.now() - start;

  log.info(
    {
      rowsAffected: affected,
      durationMs,
      event: "backfill_atm_channel_done",
    },
    `ATM channel backfill complete: ${affected} rows updated in ${durationMs}ms`,
  );

  if (affected === 0) {
    log.info(
      { event: "backfill_atm_channel_noop" },
      "No rows matched — already up to date (idempotent re-run or no ATM transactions exist)",
    );
  }
}

main().catch((err) => {
  log.error({ err, event: "backfill_atm_channel_fatal" }, "ATM channel backfill failed");
  process.exit(1);
});
