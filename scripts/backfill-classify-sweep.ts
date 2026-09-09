/**
 * One-shot backfill: run the classify-sweep pipeline (see
 * src/lib/classification/sweep.ts) once against existing data, ahead of the
 * weekly BullMQ schedule taking over. Also relocates the historical
 * `ABONO INTERESES AHORROS` rows from `otros-ingresos` to the new
 * `rendimientos` category (#809) — those are already correctly classified
 * into a REAL category, just the wrong one now that `rendimientos` exists,
 * so they fall outside classify-sweep's own `otros`/null selection and need
 * a dedicated one-time fix.
 *
 * Deliberately NOT added to deploy.yml's overlay list: unlike
 * migrate-prod.ts's dependencies (db, logger, seed-reference-data, signup),
 * this script pulls in the full classification module (ai.ts, rules.ts) and
 * the Anthropic client — a dependency graph the minimal standalone-release
 * overlay isn't designed for. Every other one-shot backfill-*.ts script in
 * this repo (backfill-cartera-tc-categories, backfill-canonical-merchant,
 * backfill-fx-metadata, etc.) follows the same precedent: run from a full
 * source checkout against the target database, not from the release
 * tarball. See engram `deploy-overlay-must-track-script-imports` — that
 * gotcha is about scripts migrate-prod.ts calls automatically, not manual
 * one-offs like this one.
 *
 * Idempotent: classify-sweep itself settles unresolved rows with a "swept"
 * classification_reason marker so re-running is a no-op for anything already
 * resolved; the ABONO INTERESES AHORROS relocation is scoped to an exact
 * (description, category_slug) match, so once rows move to `rendimientos`
 * they no longer match on a second run.
 *
 * CLI flags:
 *   --dry-run       Print the full before/after mapping without writing.
 *   --user-id=N     Only process user N (default: every active user).
 *
 * Usage:
 *   bun scripts/backfill-classify-sweep.ts --dry-run
 *   bun scripts/backfill-classify-sweep.ts --user-id=1 --dry-run
 *   bun scripts/backfill-classify-sweep.ts
 */

import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { categories, transactions, users } from "../src/lib/db/schema";
import { notDeleted } from "../src/lib/db/helpers";
import { createLogger } from "../src/lib/logger";
import { runClassifySweep, type SweepChange } from "../src/lib/classification/sweep";

const log = createLogger({ module: "backfill-classify-sweep" });

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((a) => a.startsWith("--user-id="));
const userId: number | null = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : null;

if (userId !== null && (!Number.isFinite(userId) || userId <= 0)) {
  log.error({ userIdArg: USER_ID_ARG }, "--user-id must be a positive integer");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 0: precondition — the "rendimientos" category must already exist for
// every target user before either step below runs (both assign
// category_slug='rendimientos', FK-enforced against categories(user_id, slug)).
//
// That category only reaches a user via seedReferenceData() + a per-user
// copy — either the deploy-time migrate-prod.ts flow, or a manual
// `bun run db:backfill:users` run. This script does NOT call either — it
// must not silently self-heal by inserting the category itself, since that
// would hide a real deploy-ordering mistake (running this backfill before
// the category-seed deploy landed) behind a script that "just worked".
// ---------------------------------------------------------------------------

// Exported (and takes an explicit `targetUserId` rather than reading the
// module-level `userId` CLI arg directly) so tests can exercise it without
// going through argv parsing. Throws — rather than calling `process.exit`
// itself — so the top-level `main().catch(...)` handler owns the actual
// process exit uniformly, and so this function stays testable.
export async function ensureRendimientosCategoryExists(
  targetUserId: number | null = userId,
): Promise<void> {
  const targetUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(eq(users.active, true), targetUserId !== null ? eq(users.id, targetUserId) : undefined),
    );

  if (targetUsers.length === 0) return;

  const withCategory = await db
    .select({ userId: categories.userId })
    .from(categories)
    .where(
      and(
        eq(categories.slug, "rendimientos"),
        notDeleted(categories.deletedAt),
        inArray(
          categories.userId,
          targetUsers.map((u) => u.id),
        ),
      ),
    );
  const haveIt = new Set(withCategory.map((r) => r.userId));
  const missing = targetUsers.filter((u) => !haveIt.has(u.id));

  if (missing.length > 0) {
    const message =
      `Aborting: ${missing.length} user(s) are missing the "rendimientos" category ` +
      `(user ids: ${missing.map((u) => u.id).join(", ")}). This category is added by the ` +
      `#809 seed migration but only materializes per-user via migrate-prod.ts's deploy flow ` +
      `or a manual backfill. Run "bun run db:backfill:users" ` +
      `(scripts/backfill-users-reference.ts) to materialize it for existing users, then re-run this script.`;
    log.error(
      {
        missingUserIds: missing.map((u) => u.id),
        missingEmails: missing.map((u) => u.email),
        event: "backfill_classify_sweep_precondition_failed",
      },
      message,
    );
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Step 1: ABONO INTERESES AHORROS relocation (otros-ingresos -> rendimientos)
// ---------------------------------------------------------------------------

async function relocateInterestPayouts(): Promise<{ matched: number; updated: number }> {
  const whereClause = and(
    notDeleted(transactions.deletedAt),
    ne(transactions.channel, "transfer"),
    notInArray(transactions.classificationMethod, ["manual", "manual_confirmed"]),
    eq(transactions.categorySlug, "otros-ingresos"),
    sql`${transactions.descriptionRaw} ILIKE '%ABONO INTERESES AHORROS%'`,
    userId !== null ? eq(transactions.userId, userId) : undefined,
  );

  const rows = await db
    .select({
      id: transactions.id,
      userId: transactions.userId,
      descriptionRaw: transactions.descriptionRaw,
    })
    .from(transactions)
    .where(whereClause);

  log.info(
    { count: rows.length, dryRun: DRY_RUN, event: "backfill_interest_payouts_matched" },
    `found ${rows.length} ABONO INTERESES AHORROS rows currently under otros-ingresos`,
  );

  if (rows.length === 0) return { matched: 0, updated: 0 };

  if (DRY_RUN) {
    log.info(
      { sample: rows.slice(0, 5).map((r) => ({ id: r.id, userId: r.userId })) },
      "dry-run: would move these to category_slug=rendimientos (first 5 shown)",
    );
    return { matched: rows.length, updated: 0 };
  }

  const result = await db
    .update(transactions)
    .set({ categorySlug: "rendimientos", updatedAt: new Date() })
    .where(whereClause)
    .returning({ id: transactions.id });

  return { matched: rows.length, updated: result.length };
}

// ---------------------------------------------------------------------------
// Step 2: classify-sweep pass
// ---------------------------------------------------------------------------

function printChanges(changes: SweepChange[]): void {
  for (const c of changes) {
    log.info(
      {
        txId: c.txId,
        descriptionRaw: c.descriptionRaw,
        before: c.before,
        after: c.after,
        event: "backfill_classify_sweep_change",
      },
      `tx ${c.txId}: ${c.before.categorySlug ?? "NULL"}/${c.before.classificationMethod} -> ${c.after.categorySlug}/${c.after.classificationMethod} (confidence=${c.after.confidence})`,
    );
  }
}

async function main(): Promise<void> {
  log.info(
    { dryRun: DRY_RUN, userId: userId ?? "all", event: "backfill_classify_sweep_start" },
    "starting classify-sweep backfill",
  );

  await ensureRendimientosCategoryExists();

  const interestResult = await relocateInterestPayouts();

  const sweepResult = await runClassifySweep({
    dryRun: DRY_RUN,
    ...(userId !== null ? { userId } : {}),
  });

  for (const userResult of sweepResult.perUser) {
    log.info(
      {
        userId: userResult.userId,
        picked: userResult.picked,
        priorArtClassified: userResult.priorArtClassified,
        ruleClassified: userResult.ruleClassified,
        aiClassified: userResult.aiClassified,
        settledToOtros: userResult.settledToOtros,
        categoriesCreated: userResult.categoriesCreated.map((c) => c.slug),
        event: "backfill_classify_sweep_user",
      },
      `user ${userResult.userId}: picked=${userResult.picked} priorArt=${userResult.priorArtClassified} rule=${userResult.ruleClassified} ai=${userResult.aiClassified} settled=${userResult.settledToOtros}`,
    );
    printChanges(userResult.changes);
  }

  for (const created of sweepResult.categoriesCreated) {
    log.info(
      {
        userId: created.userId,
        slug: created.slug,
        name: created.name,
        parentSlug: created.parentSlug,
        merchantExamples: created.merchantExamples,
        dryRun: DRY_RUN,
        event: "backfill_classify_sweep_category_created",
      },
      `${DRY_RUN ? "[dry-run] would create" : "created"} category "${created.slug}" under "${created.parentSlug}"`,
    );
  }

  log.info(
    {
      dryRun: DRY_RUN,
      interestPayoutsMatched: interestResult.matched,
      interestPayoutsUpdated: interestResult.updated,
      usersProcessed: sweepResult.usersProcessed,
      totalPicked: sweepResult.totalPicked,
      totalPriorArtClassified: sweepResult.totalPriorArtClassified,
      totalRuleClassified: sweepResult.totalRuleClassified,
      totalAiClassified: sweepResult.totalAiClassified,
      totalSettledToOtros: sweepResult.totalSettledToOtros,
      categoriesCreated: sweepResult.categoriesCreated.length,
      failedUserIds: sweepResult.failedUserIds,
      event: "backfill_classify_sweep_done",
    },
    `backfill ${DRY_RUN ? "dry-run" : "run"} complete: interest_payouts=${interestResult.updated}/${interestResult.matched} picked=${sweepResult.totalPicked} priorArt=${sweepResult.totalPriorArtClassified} rule=${sweepResult.totalRuleClassified} ai=${sweepResult.totalAiClassified} settled=${sweepResult.totalSettledToOtros} categoriesCreated=${sweepResult.categoriesCreated.length} failedUsers=${sweepResult.failedUserIds.length}`,
  );

  if (sweepResult.failedUserIds.length > 0) {
    log.error(
      { failedUserIds: sweepResult.failedUserIds, event: "backfill_classify_sweep_users_failed" },
      `${sweepResult.failedUserIds.length} user(s) failed during the sweep and were skipped — see earlier classify_sweep_user_failed log lines for details`,
    );
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err, event: "backfill_classify_sweep_failed" }, "backfill-classify-sweep failed");
      process.exit(1);
    });
}
