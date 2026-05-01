// Backfill the `cartera-tc` category seed for every existing active user.
//
// The global seed row was added in #687 (seed-reference-data.ts). Each user
// gets their own materialized copy via copyCategorySeedsToUser, which is
// idempotent: (user_id, slug) unique + ON CONFLICT DO NOTHING. Running this
// script again is safe.
//
// Usage:
//   bun scripts/backfill-cartera-tc-categories.ts

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { users } from "../src/lib/db/schema";
import { copyCategorySeedsToUser } from "../src/lib/auth/signup";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-cartera-tc" });

async function run(): Promise<void> {
  const allUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.active, true));

  log.info(
    { count: allUsers.length, event: "backfill_cartera_tc_start" },
    "starting cartera-tc category backfill",
  );

  let totalInserted = 0;
  for (const u of allUsers) {
    // copyCategorySeedsToUser copies every row from category_seeds that the
    // user does not yet have — idempotent via ON CONFLICT DO NOTHING.
    const inserted = await copyCategorySeedsToUser(u.id);
    totalInserted += inserted;
    log.info(
      { userId: u.id, email: u.email, inserted, event: "backfill_cartera_tc_user" },
      "processed user",
    );
  }

  log.info(
    {
      usersProcessed: allUsers.length,
      totalInserted,
      event: "backfill_cartera_tc_done",
    },
    "cartera-tc category backfill complete",
  );
}

if (import.meta.main) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error(
        { err, event: "backfill_cartera_tc_failed" },
        "backfill-cartera-tc-categories failed",
      );
      process.exit(1);
    });
}
