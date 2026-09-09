/**
 * One-shot backfill: persist merchant knowledge from existing non-otros
 * classifications. Zero cost — reads rows that already have a category, no
 * model call. Keyed on canonical_merchant; opaque gateway strings are skipped
 * unless a correlated receipt.merchant can stand in.
 *
 * NOT wired into deploy.yml's automatic step list — it is a manual one-off,
 * run by hand when needed, not on every deploy. It IS present on prod
 * though: since #848/#850 the whole scripts/ and src/ trees are overlaid
 * onto the release wholesale and the release gets a real
 * `bun install --production`, so `bun scripts/backfill-merchant-knowledge.ts`
 * runs fine from the release directory — there is no full source checkout on
 * prod to run it from instead.
 *
 * Idempotent: existing merchant_knowledge / hints rows are left alone.
 *
 * CLI flags:
 *   --dry-run       Print counts without writing.
 *   --user-id=N     Only process user N (default: every user with classified txs).
 *
 * Usage:
 *   bun scripts/backfill-merchant-knowledge.ts
 *   bun scripts/backfill-merchant-knowledge.ts --dry-run
 *   bun scripts/backfill-merchant-knowledge.ts --user-id=1
 */

import { createLogger } from "../src/lib/logger";
import { backfillMerchantKnowledge } from "../src/lib/classification/merchant-knowledge";

const log = createLogger({ module: "backfill-merchant-knowledge" });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((a) => a.startsWith("--user-id="));
const userId: number | undefined = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : undefined;

if (userId !== undefined && (!Number.isFinite(userId) || userId <= 0)) {
  log.error({ userIdArg: USER_ID_ARG }, "--user-id must be a positive integer");
  process.exit(1);
}

async function main() {
  log.info(
    { dryRun: DRY_RUN, userId: userId ?? "all", event: "backfill_merchant_knowledge_start" },
    "starting merchant-knowledge backfill",
  );
  const result = await backfillMerchantKnowledge({ userId, dryRun: DRY_RUN });
  log.info(
    { ...result, event: "backfill_merchant_knowledge_done" },
    "merchant-knowledge backfill done",
  );
}

main().catch((err: unknown) => {
  log.error({ err, event: "backfill_merchant_knowledge_fatal" }, "Backfill failed");
  process.exit(1);
});
