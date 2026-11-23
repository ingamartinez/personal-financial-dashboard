/**
 * One-shot repair (#1036 S5): link the recovered November EPM QR payment to
 * `Factura EPM 1909` (#13).
 *
 * Why a fixed script and not a backfill
 * ------------------------------------
 * The November EPM charge did not exist before #1036: its SMS named the Bre-B
 * key `@bcr8909049961epmb`, the parser only accepted digits, so the body fell to
 * `unknown_pattern` and `$600.026` was never recorded. After
 * `scripts/backfill-sms-parse-errors.ts` inserts it, this script makes the one
 * link that closes the November gap — a fixed, audited action against one
 * known row, so every identifier here is a constant.
 *
 * The transaction is resolved by its deterministic `external_id` (the hash
 * `ingestParsed` computes from kind + account + key + date/time + amount), not
 * by a prod row id nobody can know from here: there is no full checkout on the
 * server and a hardcoded id would silently point at the wrong row if the
 * backfill ran in a different order. The id is still fixed — it is derived from
 * the fixed body below, never from an argument or an environment variable.
 *
 * Refusal, not guessing
 * ---------------------
 * Anything outside the enumerated state aborts before a single write and exits
 * non-zero, listing every violation:
 *   - the fixed SMS no longer parses as a qr_payment (parser regressed)
 *   - the transaction is missing (backfill not run yet)
 *   - it is soft-deleted, or a different amount / currency / description /
 *     account than this payment
 *   - recurring #13 is missing, soft-deleted, or belongs to another user
 *   - the tx is already linked to a different recurring, or the month is
 *     already taken by another tx (the (recurring_id, recurring_month) unique
 *     index would throw mid-transaction otherwise)
 *   - the November gap is already resolved to a different transaction
 * Already linked exactly as this script would write it → no-op (idempotent).
 *
 * Safe only because of #1036 S3: the observation the link records stores the
 * llave token (`BCR8909049961EPMB`), never `LLAVE`, so this payment cannot
 * teach the recurring a generic fingerprint that any other QR payment could
 * claim by amount alone.
 *
 * Usage:
 *   bun scripts/repair-epm-qr-link.ts --dry-run
 *   bun scripts/repair-epm-qr-link.ts
 */

import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../src/lib/db";
import { recurringGaps, recurringTransactions, transactions } from "../src/lib/db/schema";
import { parseSmsBancolombia } from "../src/lib/ingestion/sms-bancolombia";
import {
  recordRecurringLinkObservation,
  tokeniseDescription,
} from "../src/lib/recurring/observation-recorder";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "repair-epm-qr-link" });

const USER_ID = 1;
/** `Factura EPM 1909` — the recurring this charge belongs to. */
const RECURRING_ID = 13;
const YEAR_MONTH = "2026-11";

/** The exact prod body (ingestion_logs id 1851) the backfill re-parses. */
const EPM_QR_SMS =
  "Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste $600,026.00 por codigo QR desde tu cuenta *6126 a la llave @bcr8909049961epmb el 22/11/2026 a las 22:37. Con codigo QR es facil y de una. Dudas al 018000912345";

/** Everything the recovered row must look like for this link to be safe. */
const EXPECTED = {
  amountCents: BigInt(-60002600),
  currency: "COP" as const,
  descriptionRaw: "Pago QR a llave @bcr8909049961epmb",
  occurredAtIso: "2026-11-23T03:37:00.000Z",
};

function parseDryRun(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--dry-run") continue;
    log.error({ arg, event: "repair_epm_qr_unknown_arg" }, "unknown argument");
    process.exit(1);
  }
  return argv.includes("--dry-run");
}

function refuse(violations: string[]): never {
  log.error(
    {
      event: "repair_epm_qr_refused",
      userId: USER_ID,
      recurringId: RECURRING_ID,
      yearMonth: YEAR_MONTH,
      violations,
    },
    "repair-epm-qr-link: refusing — state is outside the enumerated set, no writes",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));

  const parsed = parseSmsBancolombia(EPM_QR_SMS);
  if (parsed.kind !== "qr_payment") {
    refuse([`fixed SMS no longer parses as qr_payment (got: ${parsed.kind})`]);
  }
  const externalId = parsed.externalId;

  const [tx] = await db
    .select({
      id: transactions.id,
      userId: transactions.userId,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      occurredAt: transactions.occurredAt,
      recurringId: transactions.recurringId,
      recurringYearMonth: transactions.recurringYearMonth,
      deletedAt: transactions.deletedAt,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, USER_ID), eq(transactions.externalId, externalId)))
    .limit(1);

  if (!tx) {
    refuse([
      `no transaction with external_id=${externalId} for user ${USER_ID} — run the backfill first`,
    ]);
  }

  const [recurring] = await db
    .select({
      id: recurringTransactions.id,
      userId: recurringTransactions.userId,
      label: recurringTransactions.label,
      deletedAt: recurringTransactions.deletedAt,
    })
    .from(recurringTransactions)
    .where(
      and(eq(recurringTransactions.id, RECURRING_ID), eq(recurringTransactions.userId, USER_ID)),
    )
    .limit(1);

  const violations: string[] = [];
  if (tx.deletedAt !== null) violations.push("transaction is soft-deleted");
  if (tx.amountCents !== EXPECTED.amountCents) {
    violations.push(`amount_cents=${tx.amountCents} (expected ${EXPECTED.amountCents})`);
  }
  if (tx.currency !== EXPECTED.currency) {
    violations.push(`currency=${tx.currency} (expected ${EXPECTED.currency})`);
  }
  if (tx.descriptionRaw !== EXPECTED.descriptionRaw) {
    violations.push(`description_raw=${JSON.stringify(tx.descriptionRaw)} (expected this payment)`);
  }
  if (tx.occurredAt.toISOString() !== EXPECTED.occurredAtIso) {
    violations.push(
      `occurred_at=${tx.occurredAt.toISOString()} (expected ${EXPECTED.occurredAtIso})`,
    );
  }
  if (!recurring) violations.push(`recurring #${RECURRING_ID} not found for user ${USER_ID}`);
  if (recurring?.deletedAt) violations.push(`recurring #${RECURRING_ID} is soft-deleted`);
  if (tx.recurringId !== null && tx.recurringId !== RECURRING_ID) {
    violations.push(`transaction already linked to recurring #${tx.recurringId}`);
  }

  const [monthTakenBy] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, USER_ID),
        eq(transactions.recurringId, RECURRING_ID),
        eq(transactions.recurringYearMonth, YEAR_MONTH),
        ne(transactions.id, tx.id),
        isNull(transactions.deletedAt),
      ),
    )
    .limit(1);
  if (monthTakenBy) {
    violations.push(`${YEAR_MONTH} is already linked to tx ${monthTakenBy.id}`);
  }

  const [gap] = await db
    .select({
      id: recurringGaps.id,
      resolution: recurringGaps.resolution,
      resolutionTxId: recurringGaps.resolutionTxId,
    })
    .from(recurringGaps)
    .where(
      and(
        eq(recurringGaps.userId, USER_ID),
        eq(recurringGaps.recurringId, RECURRING_ID),
        eq(recurringGaps.yearMonth, YEAR_MONTH),
      ),
    )
    .limit(1);

  if (gap?.resolution && gap.resolutionTxId !== null && gap.resolutionTxId !== tx.id) {
    violations.push(
      `${YEAR_MONTH} gap already resolved as ${gap.resolution} to tx ${gap.resolutionTxId}`,
    );
  }

  if (violations.length > 0) refuse(violations);

  // #1036 S3: proves the link can only teach the llave, never the boilerplate.
  const learnedToken = tokeniseDescription(EXPECTED.descriptionRaw);
  if (learnedToken === null || learnedToken === "LLAVE") {
    refuse([`description would learn the boilerplate token ${learnedToken} as a fingerprint`]);
  }

  const alreadyLinked = tx.recurringId === RECURRING_ID && tx.recurringYearMonth === YEAR_MONTH;

  log.info(
    {
      dryRun,
      event: "repair_epm_qr_plan",
      userId: USER_ID,
      recurringId: RECURRING_ID,
      recurringLabel: recurring?.label ?? null,
      yearMonth: YEAR_MONTH,
      txId: tx.id,
      externalId,
      amountCents: tx.amountCents.toString(),
      occurredAt: tx.occurredAt.toISOString(),
      learnedToken,
      gapId: gap?.id ?? null,
      alreadyLinked,
    },
    dryRun ? "dry run — no writes" : "applying EPM QR link repair",
  );
  if (dryRun) return;
  if (alreadyLinked) {
    log.info(
      {
        event: "repair_epm_qr_noop",
        txId: tx.id,
        recurringId: RECURRING_ID,
        yearMonth: YEAR_MONTH,
      },
      "already linked exactly as this repair would write it — nothing to do",
    );
    return;
  }

  await db.transaction(async (trx) => {
    await trx
      .update(transactions)
      .set({ recurringId: RECURRING_ID, recurringYearMonth: YEAR_MONTH, updatedAt: new Date() })
      .where(
        and(
          eq(transactions.userId, USER_ID),
          eq(transactions.id, tx.id),
          isNull(transactions.recurringId),
        ),
      );

    await recordRecurringLinkObservation(
      {
        userId: USER_ID,
        recurringId: RECURRING_ID,
        txId: tx.id,
        yearMonth: YEAR_MONTH,
        manual: true,
      },
      trx,
    );

    await trx
      .update(recurringGaps)
      .set({ resolution: "linked", resolutionTxId: tx.id, resolvedAt: new Date() })
      .where(
        and(
          eq(recurringGaps.userId, USER_ID),
          eq(recurringGaps.recurringId, RECURRING_ID),
          eq(recurringGaps.yearMonth, YEAR_MONTH),
          isNull(recurringGaps.resolution),
        ),
      );
  });

  log.info(
    {
      event: "repair_epm_qr_done",
      txId: tx.id,
      recurringId: RECURRING_ID,
      yearMonth: YEAR_MONTH,
      learnedToken,
    },
    "EPM QR link repair complete",
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    log.error({ err, event: "repair_epm_qr_failed" }, "EPM QR link repair failed");
    process.exit(1);
  });
}
