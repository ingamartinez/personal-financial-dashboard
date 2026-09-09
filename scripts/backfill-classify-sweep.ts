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
 * Also performs a one-time manual assignment (#812) of 16 user-confirmed
 * MercadoPago-gateway transactions (identified from the user's own
 * MercadoPago / Mercado Libre receipts, or by matching a receipt email's
 * REDEBAN/CREDIBANCO voucher block to the transaction) to their correct
 * categories — see HOME_GOODS_MANUAL_ASSIGNMENTS below. This resolves every
 * currently-identified opaque-gateway row; the gateway-abstain path in
 * src/lib/classification/opaque-gateways.ts stays in place unweakened as the
 * standing guard for every FUTURE MercadoPago charge (until #813's parser
 * fix resolves those automatically at ingest time).
 *
 * Two of the target categories (`muebles`, `hogar`) are new, seeded for
 * every user; one (`regalos`) is a category user 1 created himself — the
 * same situation as his hand-made `4x100` in #809 — and exists ONLY for
 * that user; it is intentionally absent from seed-reference-data.ts and
 * must never be added there or backfilled for anyone else.
 *
 * Idempotent: classify-sweep itself settles/abstains unresolved rows with a
 * "swept"/"abstained" classification_reason marker so re-running is a no-op
 * for anything already resolved; the ABONO INTERESES AHORROS relocation is
 * scoped to an exact (description, category_slug) match, so once rows move
 * to `rendimientos` they no longer match on a second run; the manual
 * home-goods assignment skips any row already `manual`/`manual_confirmed`.
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
// One-time manual assignment data (#812) — every currently-identified
// opaque-gateway (MercadoPago) transaction, identified from the user's own
// MercadoPago / Mercado Libre receipts, or by matching the receipt email's
// REDEBAN/CREDIBANCO voucher block — which carries "MERCADOPAGO COLOMBIA"
// plus the exact card amount — to the transaction. All `classification_
// method = 'manual'`: these are legitimate human decisions, not AI guesses,
// so they become prior-art evidence for future sweep runs (see
// fetchPriorArtIndex in src/lib/classification/sweep.ts).
//
// Some of these were SPLIT payments (part MercadoPago balance, part card) —
// 1357 ($98,999 total / $85,211 on the card) and 1424 ($289,900-ish total /
// $266,808 on the card). The card leg is what findash holds and is correct
// as-is; do NOT "fix" the amount. Installment data in prod is already
// correct for all of these (1106 = 12 cuotas @ 18311 bps, 976 = 9,
// 1253/1313/959 = 6, the rest = 1) — do NOT touch `installments_total` or
// `installment_rate_bps` here. 1187 and 1315 are two DIFFERENT termos
// (different colours, different dates) — not a duplicate, do not dedupe.
//
// 1443, 1514, 1624 were inferred rather than read directly off a product
// line — evidence for each:
//   - 1443: the Bancolombia alert fires at 05/01 22:42 for
//     "COP149.650 en MERCADOPAGO COLOMBIA", and a JetSmart itinerary email
//     (reserva ADMGVX) arrives the same minute. JetSmart bills through
//     MercadoPago.
//   - 1514 / 1624: the bank descriptions literally contain "PASARELAEMI",
//     and prod email_receipts holds MercadoPago receipts for
//     "EMPRESA DE MEDICINA INTEGRAL EMI S.A.S. SERVICIO DE AMBULANCIA" on
//     those exact dates, at COP amounts whose implied FX (3,645 and 3,637
//     COP/USD) agree to 0.2%.
//
// Each row is scoped by the EXACT (txId, userId) pair — never inferred from
// the tx alone — matching the tenant-safety convention everywhere else in
// this codebase (memory: per-user-table-join-tenant-safety).
//
// This resolves every opaque-gateway row identified so far — it does NOT
// remove or weaken the gateway-abstain path (opaque-gateways.ts), which
// stays as the standing guard for every future MercadoPago charge.
// ---------------------------------------------------------------------------

export type ManualHomeGoodsAssignment = {
  txId: number;
  userId: number;
  categorySlug: string;
  label: string;
};

export const HOME_GOODS_MANUAL_ASSIGNMENTS: ManualHomeGoodsAssignment[] = [
  // muebles (new, under vivienda)
  { txId: 1106, userId: 1, categorySlug: "muebles", label: "colchón" },
  {
    txId: 976,
    userId: 1,
    categorySlug: "muebles",
    label: "Silla De Escritorio Con Cabecero Sam Syncro Bonno Negro Malla",
  },
  // hogar (new, under vivienda)
  { txId: 1253, userId: 1, categorySlug: "hogar", label: "Microondas Whirlpool 20lt WM1807B" },
  {
    txId: 1424,
    userId: 1,
    categorySlug: "hogar",
    label: "Estante Metálico Cubo Madera + 4 productos más",
  },
  {
    txId: 1166,
    userId: 1,
    categorySlug: "hogar",
    label: "Almohada Ortopédica Viscoelástica Cervical Memory Set X 2",
  },
  { txId: 1313, userId: 1, categorySlug: "hogar", label: "Tendedero de ropa plegable Nona Minda" },
  {
    txId: 1187,
    userId: 1,
    categorySlug: "hogar",
    label: "Termo Botella Térmica Buffer 800ml — Soaked Lilac",
  },
  {
    txId: 1315,
    userId: 1,
    categorySlug: "hogar",
    label: "Termo Botella Térmica Buffer 800ml — Ice Leopard",
  },
  {
    txId: 956,
    userId: 1,
    categorySlug: "hogar",
    label: "Ventilador De Techo Con Luz Led En Forma De Flor 40w",
  },
  // existing categories
  { txId: 1041, userId: 1, categorySlug: "vivienda", label: "mudanza (Mudango Light)" },
  {
    txId: 972,
    userId: 1,
    categorySlug: "entretenimiento",
    label: "tiquetes para un partido de fútbol",
  },
  { txId: 959, userId: 1, categorySlug: "tecnologia", label: "Xiaomi Smart Band 10 Amoled" },
  {
    txId: 1443,
    userId: 1,
    categorySlug: "transporte",
    label: "tiquetes JetSmart (reserva ADMGVX)",
  },
  // user-created category (NOT in seed-reference-data.ts — see module doc).
  {
    txId: 1357,
    userId: 1,
    categorySlug: "regalos",
    label: 'Collar Mujer Gato Luna Cristales Plata 925 "Regalo Ideal"',
  },
  {
    txId: 1514,
    userId: 1,
    categorySlug: "salud",
    label: "EMI medicina prepagada (MERCPAGO*PASARELAEMI)",
  },
  {
    txId: 1624,
    userId: 1,
    categorySlug: "salud",
    label: "EMI medicina prepagada (Mercado Pago*PASARELAE)",
  },
];

// ---------------------------------------------------------------------------
// Step 0: precondition — every category this run is about to write to must
// already exist for its target user, checked ALL AT ONCE before any write
// happens. Previously (pre-#812 review) a missing category would surface as
// a raw FK violation from transactions_user_category_fk mid-run instead of
// one actionable error up front naming every missing (user_id, slug) pair.
//
// Two different kinds of category populate this check:
//   - Seeded, per-user-materialized categories (rendimientos, muebles,
//     hogar, vivienda, tecnologia, entretenimiento, transporte, salud) —
//     added by seedReferenceData() but only materialized per-user via
//     migrate-prod.ts's deploy flow or a manual `bun run db:backfill:users`.
//     This script does NOT call either itself — it must not silently
//     self-heal by inserting the category, since that would hide a real
//     deploy-ordering mistake behind a script that "just worked".
//   - A user-created category no seed knows about (`regalos`, for user 1
//     only — same situation as the user's own hand-made `4x100` in #809).
//     This can NEVER be backfilled by `db:backfill:users` — if missing, the
//     fix is "verify with the user", not "run a script".
// ---------------------------------------------------------------------------

export type CategoryRequirement = { userId: number; slug: string };

/**
 * Verify every (userId, slug) pair in `requirements` already exists as a
 * live category row. Aborts (throws), naming every missing pair at once,
 * rather than partially proceeding and letting a later step hit a raw FK
 * violation. Not exported directly — use the named entry points below
 * (`ensureRendimientosCategoryExists`, `ensureHomeGoodsCategoriesExist`) so
 * callers state their intent and get a well-scoped error.
 */
async function ensureCategoriesExist(requirements: CategoryRequirement[]): Promise<void> {
  const uniqueByKey = new Map<string, CategoryRequirement>();
  for (const r of requirements) uniqueByKey.set(`${r.userId}:${r.slug}`, r);
  const unique = [...uniqueByKey.values()];
  if (unique.length === 0) return;

  const userIds = [...new Set(unique.map((r) => r.userId))];
  const existing = await db
    .select({ userId: categories.userId, slug: categories.slug })
    .from(categories)
    .where(and(inArray(categories.userId, userIds), notDeleted(categories.deletedAt)));
  const have = new Set(existing.map((r) => `${r.userId}:${r.slug}`));
  const missing = unique.filter((r) => !have.has(`${r.userId}:${r.slug}`));

  if (missing.length > 0) {
    const message =
      `Aborting: ${missing.length} required (user_id, slug) categor${missing.length === 1 ? "y is" : "ies are"} ` +
      `missing before any write: ${missing.map((m) => `(${m.userId}, ${m.slug})`).join(", ")}. ` +
      `A seeded category (rendimientos, muebles, hogar, vivienda, tecnologia, ...) materializes ` +
      `per-user via migrate-prod.ts's deploy flow or a manual "bun run db:backfill:users" ` +
      `(scripts/backfill-users-reference.ts) — run that and re-run this script. A category NOT in ` +
      `src/lib/db/seed-reference-data.ts (e.g. a user-created one like "regalos") can never be ` +
      `backfilled that way — if missing, verify directly with the user before proceeding.`;
    log.error({ missing, event: "backfill_classify_sweep_precondition_failed" }, message);
    throw new Error(message);
  }
}

// Exported (and takes an explicit `targetUserId` rather than reading the
// module-level `userId` CLI arg directly) so tests can exercise it without
// going through argv parsing. Throws — rather than calling `process.exit`
// itself — so the top-level `main().catch(...)` handler owns the actual
// process exit uniformly, and so this function stays testable.
export async function ensureRendimientosCategoryExists(
  targetUserId: number | null = userId,
): Promise<void> {
  const targetUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.active, true), targetUserId !== null ? eq(users.id, targetUserId) : undefined),
    );
  return ensureCategoriesExist(targetUsers.map((u) => ({ userId: u.id, slug: "rendimientos" })));
}

// #812: single combined precondition for the manual home-goods assignment
// below — covers muebles, hogar, vivienda, tecnologia, AND regalos in one
// pass, scoped to each assignment's OWN target user (deliberately never
// "every active user" — `regalos` in particular exists only for user 1, a
// category he created himself that no seed will ever backfill for anyone
// else).
export async function ensureHomeGoodsCategoriesExist(
  assignments: ManualHomeGoodsAssignment[] = HOME_GOODS_MANUAL_ASSIGNMENTS,
  scopedUserId: number | null = userId,
): Promise<void> {
  const inScope = assignments.filter((a) => scopedUserId === null || a.userId === scopedUserId);
  return ensureCategoriesExist(inScope.map((a) => ({ userId: a.userId, slug: a.categorySlug })));
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
// Step 2: one-time manual assignment — user-confirmed home purchases (#812)
// ---------------------------------------------------------------------------
//
// Idempotent: skips (never overwrites) any row whose classification_method
// is already 'manual' or 'manual_confirmed', so a re-run is a no-op against
// both its own prior run AND a later human edit made directly in the UI.

// Exported (and takes explicit `assignments`/`scopedUserId` rather than
// reading the module-level constants directly) so tests can exercise this
// against fixtures instead of the real prod tx ids — same rationale as
// ensureRendimientosCategoryExists above.
export async function assignManualHomeGoodsTx(
  assignments: ManualHomeGoodsAssignment[] = HOME_GOODS_MANUAL_ASSIGNMENTS,
  scopedUserId: number | null = userId,
): Promise<{ txId: number; updated: boolean }[]> {
  const results: { txId: number; updated: boolean }[] = [];

  for (const assignment of assignments) {
    // Respect --user-id scoping: an assignment for a different user is out
    // of scope for this invocation, not an error.
    if (scopedUserId !== null && assignment.userId !== scopedUserId) {
      results.push({ txId: assignment.txId, updated: false });
      continue;
    }

    const [row] = await db
      .select({
        id: transactions.id,
        categorySlug: transactions.categorySlug,
        classificationMethod: transactions.classificationMethod,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.id, assignment.txId),
          eq(transactions.userId, assignment.userId),
          notDeleted(transactions.deletedAt),
        ),
      )
      .limit(1);

    if (!row) {
      log.warn(
        {
          txId: assignment.txId,
          userId: assignment.userId,
          label: assignment.label,
          event: "backfill_home_goods_tx_not_found",
        },
        `tx ${assignment.txId} (${assignment.label}) not found for user ${assignment.userId} — skipping`,
      );
      results.push({ txId: assignment.txId, updated: false });
      continue;
    }

    if (row.classificationMethod === "manual" || row.classificationMethod === "manual_confirmed") {
      // Already a human decision — either this script's own prior run, or a
      // later manual edit made directly in the UI. Never clobber either.
      results.push({ txId: assignment.txId, updated: false });
      continue;
    }

    if (DRY_RUN) {
      log.info(
        {
          txId: assignment.txId,
          userId: assignment.userId,
          categorySlug: assignment.categorySlug,
          label: assignment.label,
          event: "backfill_home_goods_tx_dry_run",
        },
        `dry-run: would assign tx ${assignment.txId} (${assignment.label}) to ${assignment.categorySlug} as manual`,
      );
      results.push({ txId: assignment.txId, updated: false });
      continue;
    }

    await db
      .update(transactions)
      .set({
        categorySlug: assignment.categorySlug,
        classificationMethod: "manual",
        classificationConfidence: 100,
        classificationReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, assignment.txId), eq(transactions.userId, assignment.userId)));

    log.info(
      {
        txId: assignment.txId,
        userId: assignment.userId,
        categorySlug: assignment.categorySlug,
        label: assignment.label,
        event: "backfill_home_goods_tx_assigned",
      },
      `assigned tx ${assignment.txId} (${assignment.label}) to ${assignment.categorySlug} as manual`,
    );
    results.push({ txId: assignment.txId, updated: true });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Step 3: classify-sweep pass
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

  // Every category any step below writes to, checked in one pass before any
  // write happens (#812 review).
  await ensureRendimientosCategoryExists();
  await ensureHomeGoodsCategoriesExist();

  const interestResult = await relocateInterestPayouts();
  const homeGoodsResult = await assignManualHomeGoodsTx();

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
        abstainedGateway: userResult.abstainedGateway,
        abstainedTransferPair: userResult.abstainedTransferPair,
        categoriesCreated: userResult.categoriesCreated.map((c) => c.slug),
        event: "backfill_classify_sweep_user",
      },
      `user ${userResult.userId}: picked=${userResult.picked} priorArt=${userResult.priorArtClassified} rule=${userResult.ruleClassified} ai=${userResult.aiClassified} settled=${userResult.settledToOtros} abstainedGateway=${userResult.abstainedGateway} abstainedTransferPair=${userResult.abstainedTransferPair}`,
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
      homeGoodsAssigned: homeGoodsResult.filter((r) => r.updated).length,
      homeGoodsTotal: homeGoodsResult.length,
      usersProcessed: sweepResult.usersProcessed,
      totalPicked: sweepResult.totalPicked,
      totalPriorArtClassified: sweepResult.totalPriorArtClassified,
      totalRuleClassified: sweepResult.totalRuleClassified,
      totalAiClassified: sweepResult.totalAiClassified,
      totalSettledToOtros: sweepResult.totalSettledToOtros,
      totalAbstainedGateway: sweepResult.totalAbstainedGateway,
      totalAbstainedTransferPair: sweepResult.totalAbstainedTransferPair,
      categoriesCreated: sweepResult.categoriesCreated.length,
      failedUserIds: sweepResult.failedUserIds,
      event: "backfill_classify_sweep_done",
    },
    `backfill ${DRY_RUN ? "dry-run" : "run"} complete: interest_payouts=${interestResult.updated}/${interestResult.matched} home_goods=${homeGoodsResult.filter((r) => r.updated).length}/${homeGoodsResult.length} picked=${sweepResult.totalPicked} priorArt=${sweepResult.totalPriorArtClassified} rule=${sweepResult.totalRuleClassified} ai=${sweepResult.totalAiClassified} settled=${sweepResult.totalSettledToOtros} abstainedGateway=${sweepResult.totalAbstainedGateway} abstainedTransferPair=${sweepResult.totalAbstainedTransferPair} categoriesCreated=${sweepResult.categoriesCreated.length} failedUsers=${sweepResult.failedUserIds.length}`,
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
