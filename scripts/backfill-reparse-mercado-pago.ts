/**
 * One-shot backfill (#814 Phase 1): re-parse unmatched/pending Mercado Pago
 * receipts after the voucher-block parser and observable skip/failure
 * recording landed. Recovers the silent all-NULL rows (parsed_at set,
 * merchant/amount NULL, no reason in parsed_payload) and any Mercado Libre
 * "Compraste …" mail that was ingested under gateway=mercado_pago.
 *
 * Does NOT touch matched/ambiguous receipts. Does NOT invent a match for
 * the EMI COP receipts whose bank legs are USD on ARQ — that is Phase 2.
 *
 * NOT wired into deploy.yml's automatic step list — it is a manual one-off,
 * run by hand against a target database when needed, not on every deploy.
 * It IS present on prod though: since #848/#850 the whole scripts/ and src/
 * trees are overlaid onto the release wholesale and the release gets a real
 * `bun install --production`, so this script's Gmail pull/enrich graph
 * imports (googleapis included) resolve fine run as
 * `bun scripts/backfill-reparse-mercado-pago.ts` from the release
 * directory — there is no full checkout on prod to run it from instead.
 *
 * CLI flags:
 *   --dry-run       Print how many rows would be reset, write nothing.
 *   --user-id=N     Only process user N (default: every user with rows).
 *
 * Usage:
 *   bun scripts/backfill-reparse-mercado-pago.ts --dry-run
 *   bun scripts/backfill-reparse-mercado-pago.ts --user-id=1 --dry-run
 *   bun scripts/backfill-reparse-mercado-pago.ts
 */

import { createLogger } from "../src/lib/logger";
import {
  countUnmatchedMercadoPagoReceipts,
  reparseUnmatchedMercadoPagoReceipts,
} from "../src/lib/gmail/reparse-mercado-pago";

const log = createLogger({ module: "backfill-reparse-mercado-pago" });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((a) => a.startsWith("--user-id="));
const userId: number | undefined = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : undefined;

if (userId !== undefined && (!Number.isFinite(userId) || userId <= 0)) {
  log.error({ userIdArg: USER_ID_ARG }, "--user-id must be a positive integer");
  process.exit(1);
}

const count = await countUnmatchedMercadoPagoReceipts({ userId });
if (DRY_RUN) {
  log.info(
    { count, userId: userId ?? null, dryRun: true, event: "mp_reparse_dry_run" },
    "would reparse unmatched mercado_pago receipts",
  );
  process.exit(0);
}

const report = await reparseUnmatchedMercadoPagoReceipts({ userId });
log.info(
  { ...report, userId: userId ?? null, event: "mp_reparse_backfill_done" },
  "reparsed unmatched mercado_pago receipts",
);
process.exit(0);
