import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { runSeed } from "../src/lib/db/seed";

const CONFIRM_TOKEN = "I_KNOW_THIS_WIPES_EVERYTHING";

async function main() {
  const arg = process.argv[2];
  if (arg !== CONFIRM_TOKEN) {
    console.error(
      `\nThis script WIPES transactions, accounts, recurring, snapshots,\n` +
        `ingestion_logs, and insights_reports. Categories, classification_rules,\n` +
        `and budgets are preserved.\n\n` +
        `To run: bun run scripts/reset-and-reseed.ts ${CONFIRM_TOKEN}\n`,
    );
    process.exit(1);
  }

  console.log("wiping transactional tables...");
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
  console.log("  wiped.");

  console.log("re-seeding (categories, accounts, rules)...");
  await runSeed();

  console.log("\ndone. Final state:");
  const accs = await db.execute<{
    id: number;
    name: string;
    currency: string;
    metadata: Record<string, unknown>;
  }>(sql`SELECT id, name, currency, metadata FROM accounts ORDER BY id`);
  for (const a of accs) {
    console.log(
      `  [${a.id}] ${a.name} (${a.currency}) — last4s: ${JSON.stringify(a.metadata?.last4s ?? [])}`,
    );
  }

  await db.$client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
