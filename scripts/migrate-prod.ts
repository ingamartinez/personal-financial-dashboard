// Production migration runner. Runs three stages in order, all idempotent:
//
//   1. Drizzle migrations (schema DDL + any inline DML inside a migration file)
//   2. Reference data seeding (global category_seeds + classification_rule_seeds)
//   3. Per-user backfill (every active user gets their categories + rules)
//
// Invoked from the CD workflow as:
//   sudo -n -u findash bun scripts/migrate-prod.ts
//
// Expects:
//   - cwd at the release dir (reads ./drizzle/ for migration SQL)
//   - Postgres reachable via peer auth over /var/run/postgresql (no password)
//   - PGDATABASE env set (defaults to `findash` via src/lib/db parity)

import { migrate } from "drizzle-orm/postgres-js/migrator";
// Relative imports — deploy.yml overlays scripts/ + src/lib/ preserving this
// layout so dev and prod resolve these identically.
import { db } from "../src/lib/db";
import { seedReferenceData } from "../src/lib/db/seed-reference-data";
import { backfillUsersReferenceData } from "./backfill-users-reference";

const target = process.env.PGDATABASE ?? "findash";

console.log(`[migrate-prod] applying migrations from ./drizzle against ${target}...`);
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[migrate-prod] migrations applied.");

console.log("[migrate-prod] seeding global reference data...");
const refResult = await seedReferenceData(db);
console.log(
  `[migrate-prod] reference data: +${refResult.categorySeeds} category seeds, +${refResult.ruleSeeds} rule seeds (existing rows skipped).`,
);

console.log("[migrate-prod] backfilling per-user categories + rules for active users...");
const backfill = await backfillUsersReferenceData();
for (const r of backfill) {
  if (r.categories > 0 || r.rules > 0) {
    console.log(
      `[migrate-prod]   user=${r.userId} <${r.email}>: +${r.categories} categories, +${r.rules} rules`,
    );
  }
}
console.log(`[migrate-prod] backfill complete — processed ${backfill.length} active users.`);

await db.$client.end();
