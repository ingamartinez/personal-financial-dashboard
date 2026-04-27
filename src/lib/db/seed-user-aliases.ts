// Permanent seed for user_aliases — canonical name variants used by the
// cross-currency transfer pairer (#518) to recognise self-transfers in
// ARQ email data.
//
// Design: TS function (NOT a drizzle migration) — matches the established
// pattern of seedReferenceData / backfillUsersReferenceData / migratePagoTcToTransfer
// and avoids the drizzle-snapshot-chain-gotcha (engram).
//
// Idempotency:
//   - Canonical aliases: INSERT ... ON CONFLICT DO NOTHING
//   - Deprecated aliases: DELETE WHERE alias IN (...) AND user_id = userId
//
// Tenant safety: all queries scope to userId — never operate on alias alone.

import { and, eq, inArray } from "drizzle-orm";
import { createLogger } from "../logger";
import type { DB } from "./index";
import { userAliases, users } from "./schema";

const log = createLogger({ module: "seed-user-aliases" });

type AliasSeedSpec = {
  /** Email address used to look up the user. Skipped if no user found. */
  email: string;
  /** Canonical aliases to ensure exist. */
  aliases: readonly string[];
  /**
   * Deprecated aliases to remove if present — typically ones that were
   * manually inserted in dev/prod but are unsafe (no evidence, or name
   * collides with a known third party).
   */
  deprecated: readonly string[];
};

/**
 * Canonical alias set for the operator account.
 *
 * Validated against 11 real ARQ transactions in dev DB (2026-04-26):
 *   - "Alejandro Rafael Martinez Maldonado" — appears verbatim in ARQ data
 *   - "Alejandro Rafael Martinez" — plausible bank variant (drop second surname)
 *   - "Alejandro Martinez Maldonado" — plausible bank variant (drop second given name)
 *
 * NOT included — reasons documented:
 *   - "Alejandro Martinez": already matched via users.name in checkRecipientIsUser
 *   - "Alejandro Rafael": no evidence in real data
 *   - "Rafael Martinez": collides with user's father's name; would mislabel
 *     third-party transfers as self-transfers
 */
export const USER_ALIAS_SEEDS: readonly AliasSeedSpec[] = [
  {
    email: "ing.amartinez94@gmail.com",
    aliases: [
      "Alejandro Rafael Martinez Maldonado",
      "Alejandro Rafael Martinez",
      "Alejandro Martinez Maldonado",
    ],
    deprecated: ["Alejandro Rafael", "Rafael Martinez"],
  },
];

/**
 * Upserts canonical user aliases and removes deprecated ones.
 *
 * Safe to call on every deploy — all operations are idempotent.
 * Skips silently when no user with the target email exists (covers fresh
 * dev DBs with a different BOOTSTRAP_USER_EMAIL).
 *
 * @param database  Drizzle DB instance.
 * @param specs     Override the default USER_ALIAS_SEEDS — useful in tests
 *                  to scope operations to a test-local user without touching
 *                  the real operator account.
 */
export async function seedUserAliases(
  database: DB,
  specs: readonly AliasSeedSpec[] = USER_ALIAS_SEEDS,
): Promise<void> {
  for (const { email, aliases, deprecated } of specs) {
    const userRows = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (userRows.length === 0) {
      log.debug(
        { email, event: "seed_user_aliases_user_not_found" },
        "skipping alias seed; no user with email",
      );
      continue;
    }

    const userId = userRows[0].id;

    // DELETE deprecated aliases (idempotent — no-op if already absent).
    if (deprecated.length > 0) {
      const removed = await database
        .delete(userAliases)
        .where(and(eq(userAliases.userId, userId), inArray(userAliases.alias, [...deprecated])))
        .returning({ alias: userAliases.alias });

      if (removed.length > 0) {
        log.info(
          {
            userId,
            removedCount: removed.length,
            removed: removed.map((r) => r.alias),
            event: "seed_user_aliases_deprecated_removed",
          },
          "removed deprecated user aliases",
        );
      }
    }

    // INSERT canonical aliases — ON CONFLICT DO NOTHING for idempotency.
    const inserted = await database
      .insert(userAliases)
      .values(aliases.map((alias) => ({ userId, alias })))
      .onConflictDoNothing()
      .returning({ alias: userAliases.alias });

    if (inserted.length > 0) {
      log.info(
        {
          userId,
          email,
          totalAliases: aliases.length,
          insertedCount: inserted.length,
          event: "seed_user_aliases_done",
        },
        "seeded user aliases",
      );
    } else {
      log.debug(
        { userId, email, event: "seed_user_aliases_already_seeded" },
        "user aliases already seeded; no inserts",
      );
    }
  }
}
