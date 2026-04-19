// One-shot backfill for existing users: ensure every user has their own copy
// of the global category + classification-rule templates.
//
// Safe to run any number of times — both copy hooks are idempotent via
// (user_id, slug) / (user_id, pattern, category_slug) unique + ON CONFLICT.
//
// Invoked automatically from `scripts/migrate-prod.ts` after migrations +
// seedReferenceData, so every deploy self-heals partial states. Can also be
// invoked manually via `bun run db:backfill:users`.

import { eq } from "drizzle-orm";
// Relative paths — this file is also overlaid to $STAGE/scripts/ on prod.
import { db } from "../src/lib/db";
import { users } from "../src/lib/db/schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "../src/lib/auth/signup";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-users-reference" });

export async function backfillUsersReferenceData(): Promise<
  { userId: number; email: string; categories: number; rules: number }[]
> {
  const allUsers = await db
    .select({ id: users.id, email: users.email, active: users.active })
    .from(users)
    .where(eq(users.active, true));

  const results: { userId: number; email: string; categories: number; rules: number }[] = [];
  for (const u of allUsers) {
    // Order matters: categories must exist before classification_rules' FK
    // composite resolves.
    const categories = await copyCategorySeedsToUser(u.id);
    const rules = await copyRuleSeedsToUser(u.id);
    results.push({ userId: u.id, email: u.email, categories, rules });
  }
  return results;
}

if (import.meta.main) {
  backfillUsersReferenceData()
    .then((rows) => {
      for (const r of rows) {
        log.info(
          {
            userId: r.userId,
            email: r.email,
            categories: r.categories,
            rules: r.rules,
            event: "backfill_users_row",
          },
          "backfilled user reference data",
        );
      }
      log.info(
        { count: rows.length, event: "backfill_users_done" },
        "backfill done — processed active users",
      );
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err, event: "backfill_users_failed" }, "backfill-users-reference failed");
      process.exit(1);
    });
}
