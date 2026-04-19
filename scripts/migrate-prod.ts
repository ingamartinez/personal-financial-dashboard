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
import { createLogger } from "../src/lib/logger";
import { backfillUsersReferenceData } from "./backfill-users-reference";

const log = createLogger({ module: "migrate-prod" });

const target = process.env.PGDATABASE ?? "findash";

log.info({ target, event: "migrate_prod_start" }, "applying migrations from ./drizzle");
await migrate(db, { migrationsFolder: "./drizzle" });
log.info({ event: "migrate_prod_migrations_applied" }, "migrations applied");

log.info({ event: "migrate_prod_seed_ref_start" }, "seeding global reference data");
const refResult = await seedReferenceData(db);
log.info(
  {
    categorySeeds: refResult.categorySeeds,
    ruleSeeds: refResult.ruleSeeds,
    event: "migrate_prod_seed_ref_done",
  },
  "reference data seeded (existing rows skipped)",
);

log.info(
  { event: "migrate_prod_backfill_start" },
  "backfilling per-user categories + rules for active users",
);
const backfill = await backfillUsersReferenceData();
for (const r of backfill) {
  if (r.categories > 0 || r.rules > 0) {
    log.info(
      {
        userId: r.userId,
        email: r.email,
        categories: r.categories,
        rules: r.rules,
        event: "migrate_prod_backfill_row",
      },
      "backfilled user",
    );
  }
}
log.info(
  { count: backfill.length, event: "migrate_prod_backfill_done" },
  "backfill complete — processed active users",
);

await db.$client.end();
