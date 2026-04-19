import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { runSeed } from "../src/lib/db/seed";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "reset-and-reseed" });

const CONFIRM_TOKEN = "I_KNOW_THIS_WIPES_EVERYTHING";

async function main() {
  const arg = process.argv[2];
  if (arg !== CONFIRM_TOKEN) {
    log.error(
      { confirmToken: CONFIRM_TOKEN, event: "reset_reseed_confirm_required" },
      "This script WIPES transactions, accounts, recurring, snapshots, ingestion_logs, and insights_reports. Categories, classification_rules, and budgets are preserved. Pass the confirm token to run.",
    );
    process.exit(1);
  }

  log.info({ event: "reset_reseed_wipe_start" }, "wiping transactional tables");
  // TRUNCATE ... CASCADE handles transactions.onDelete=restrict by truncating
  // dependents together. accounts has FKs from transactions/recurring/snapshots.
  await db.execute(sql`
    TRUNCATE
      transactions,
      recurring_transactions,
      account_snapshots,
      ingestion_logs,
      accounts,
      insights_reports
    RESTART IDENTITY CASCADE;
  `);
  log.info({ event: "reset_reseed_wiped" }, "wiped transactional tables");

  log.info({ event: "reset_reseed_reseed_start" }, "re-seeding (categories, accounts, rules)");
  await runSeed();

  const accs = await db.execute<{
    id: number;
    name: string;
    currency: string;
    metadata: Record<string, unknown>;
  }>(sql`SELECT id, name, currency, metadata FROM accounts ORDER BY id`);
  log.info({ accounts: accs, event: "reset_reseed_done" }, "done — final accounts state");

  await db.$client.end();
  process.exit(0);
}

main().catch((err) => {
  log.error({ err, event: "reset_reseed_failed" }, "reset-and-reseed failed");
  process.exit(1);
});
