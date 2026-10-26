/**
 * One-shot repair for ARQ (gmail) payments received that were stored with
 * `channel = 'transfer'` even though they are third-party income (#1020).
 *
 * What it repairs
 * ---------------
 * `notInternalMovement` (src/lib/db/helpers.ts) excludes
 * `channel IN ('transfer', 'cash_withdrawal')` from every income/spend
 * aggregate, so an inbound ARQ payment from a client or employer stored as
 * `transfer` silently disappears from the income totals — prod tx 3130, dev
 * txs 1468/1470/1472/1745 (`CODEBRANCH LLC` salary rows). The ingestion rule
 * fixed in #1020 now labels those rows `bank` (the `tx_channel` default —
 * `manual` would claim a human entered it); this script re-channels the rows
 * that were written before that fix.
 *
 * What it deliberately leaves alone
 * ---------------------------------
 * - Self-transfers. A `transfer_received` whose counterparty name matches the
 *   owner's `users.name` or one of their `user_aliases` rows is the credit leg
 *   of a movement between the user's own accounts and keeps `transfer`. The
 *   check reuses `isUserNameOrAlias` (src/lib/transfers/intra-user-pair.ts) —
 *   the same rule ingestion and the pairer apply — so no second definition of
 *   "the user" lives here. The name is read from `raw_data.arq.recipient_name`
 *   first (the field the pairer matches on), then `merchant`, then
 *   `description_raw`. Rows already carrying a `transfer_group_id` are skipped
 *   outright: a grouped row is by definition an internal movement, and
 *   splitting one leg off its group would make it count as income.
 * - `transfer_sent` rows. Out of scope by design: flipping historical outgoing
 *   ARQ payouts to `bank` would retroactively pull every one of them into
 *   expense totals. This script only matches `raw_data.kind =
 *   'transfer_received'`.
 * - Every other column. Only `channel` and `updated_at` are written; the
 *   `raw_data` payload, `transfer_group_id` and the rest are untouched.
 *
 * Candidate predicate (tenant-safe, identical to what ingestion now produces)
 * --------------------------------------------------------------------------
 *   source = 'gmail_arq'
 *   AND deleted_at IS NULL
 *   AND amount_cents > 0
 *   AND channel = 'transfer'
 *   AND transfer_group_id IS NULL
 *   AND raw_data->>'kind' = 'transfer_received'
 *   AND counterparty name is not the user (users.name / user_aliases)
 *
 * The rows are discovered, never enumerated, so the script is correct on prod
 * ids nobody can list from here.
 *
 * Usage
 * -----
 *   bun scripts/repair-arq-received-channel.ts --dry-run
 *   bun scripts/repair-arq-received-channel.ts --dry-run --user-id=1
 *   bun scripts/repair-arq-received-channel.ts
 *
 *   --dry-run     list every affected row (`event: repair_arq_received_channel_row`)
 *                 plus a summary line, and write nothing
 *   --user-id=N   restrict the repair to one user (default: every user)
 *   --help        print this usage and exit
 *
 * Manual and one-off
 * ------------------
 * Nothing wires this into deploy, the cron list or the queue. A human runs it,
 * dry-run first, against a known instance.
 *
 * Idempotent: the write is a single UPDATE guarded by `channel = 'transfer'`,
 * so a re-run finds nothing to change.
 *
 * Relative imports on purpose — scripts are overlaid to $STAGE/scripts/ on prod
 * deploys (see memory deploy-overlay-must-track-script-imports).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { transactions } from "../src/lib/db/schema";
import { createLogger } from "../src/lib/logger";
import { isUserNameOrAlias } from "../src/lib/transfers/intra-user-pair";

const log = createLogger({ module: "repair-arq-received-channel" });

const ARQ_SOURCE = "gmail_arq" as const;
const RECEIVED_KIND = "transfer_received";
const WRONG_CHANNEL = "transfer" as const;
const RIGHT_CHANNEL = "bank" as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One row the repair would re-channel, as found by the candidate predicate. */
export type RepairRow = {
  txId: number;
  userId: number;
  merchant: string | null;
  /** Money stays a string end to end — never a float. */
  amountCents: string;
  occurredAt: Date;
};

export type RepairPlan = {
  /** Every row the candidate predicate matched, i.e. what a dry run lists. */
  rows: RepairRow[];
  /** Rows actually written. Always 0 on a dry run, and 0 when there is nothing to fix. */
  changed: number;
};

export type RepairOptions = {
  dryRun: boolean;
  /** Restrict the repair to one user. Omitted means every user. */
  userId?: number;
};

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

type Candidate = {
  id: number;
  userId: number;
  merchant: string | null;
  descriptionRaw: string;
  amountCents: bigint;
  occurredAt: Date;
  /** `arq.recipient_name` — the field the intra-user pairer matches on. */
  arqRecipientName: string | null;
};

/**
 * Live ARQ receipts from a third party that still carry `channel='transfer'`.
 *
 * The name check happens in `planRepair`, not here: `isUserNameOrAlias` is an
 * async helper that must run per row against the row's own user, and keeping
 * SQL and the identity rule apart is what lets the helper stay the single
 * definition of "the user".
 */
async function findCandidates(userId: number | undefined): Promise<Candidate[]> {
  const filters = [
    eq(transactions.source, ARQ_SOURCE),
    isNull(transactions.deletedAt),
    sql`${transactions.amountCents} > 0`,
    eq(transactions.channel, WRONG_CHANNEL),
    // A grouped row is already known to be an internal movement.
    isNull(transactions.transferGroupId),
    sql`${transactions.rawData} ->> 'kind' = ${RECEIVED_KIND}`,
  ];
  if (userId !== undefined) filters.push(eq(transactions.userId, userId));

  const rows = await db
    .select({
      id: transactions.id,
      userId: transactions.userId,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      arqRecipientName: sql<string | null>`${transactions.rawData} -> 'arq' ->> 'recipient_name'`,
    })
    .from(transactions)
    .where(and(...filters))
    .orderBy(transactions.id);

  return rows;
}

/**
 * `arq.recipient_name` is what ingestion wrote as the parsed counterparty and
 * what the pairer matches against the user; `merchant` and then
 * `description_raw` are the fallbacks for rows that predate it.
 */
function counterpartyName(row: Candidate): string {
  return row.arqRecipientName ?? row.merchant ?? row.descriptionRaw;
}

// ---------------------------------------------------------------------------
// Core repair
// ---------------------------------------------------------------------------

/**
 * Re-channel every historical ARQ third-party payment received to `bank`.
 *
 * Returns the plan either way: `rows` is what the predicate found (so a dry run
 * can be reviewed line by line), `changed` is what was actually written.
 */
export async function repairArqReceivedChannel(opts: RepairOptions): Promise<RepairPlan> {
  const candidates = await findCandidates(opts.userId);
  const rows: RepairRow[] = [];

  for (const candidate of candidates) {
    if (await isUserNameOrAlias(db, candidate.userId, counterpartyName(candidate))) {
      log.debug(
        {
          txId: candidate.id,
          userId: candidate.userId,
          event: "repair_arq_received_channel_self_transfer",
        },
        "counterparty is the user; a self-transfer keeps channel=transfer",
      );
      continue;
    }
    rows.push({
      txId: candidate.id,
      userId: candidate.userId,
      merchant: candidate.merchant,
      amountCents: candidate.amountCents.toString(),
      occurredAt: candidate.occurredAt,
    });
  }

  // One line per affected row: the operant artifact when this runs with
  // --dry-run. `merchant` is user data and stays a structured field, never
  // interpolated into the message string.
  for (const row of rows) {
    log.info(
      {
        txId: row.txId,
        userId: row.userId,
        merchant: row.merchant,
        amountCents: row.amountCents,
        occurredAt: row.occurredAt.toISOString(),
        fromChannel: WRONG_CHANNEL,
        toChannel: RIGHT_CHANNEL,
        dryRun: opts.dryRun,
        event: "repair_arq_received_channel_row",
      },
      "ARQ third-party payment received stored as transfer",
    );
  }

  if (opts.dryRun) {
    log.info(
      {
        userId: opts.userId ?? null,
        affected: rows.length,
        changed: 0,
        dryRun: true,
        event: "repair_arq_received_channel_plan",
      },
      "dry run — nothing written",
    );
    return { rows, changed: 0 };
  }

  if (rows.length === 0) {
    log.info(
      {
        userId: opts.userId ?? null,
        affected: 0,
        changed: 0,
        dryRun: false,
        event: "repair_arq_received_channel_applied",
      },
      "nothing to repair",
    );
    return { rows, changed: 0 };
  }

  // Single guarded UPDATE. Every predicate is repeated here so a row that
  // changed between the read and the write is left alone: a leg that gained a
  // `transfer_group_id` (pairer), was soft-deleted, or was already re-channelled
  // by another process must not be flipped.
  const updated = await db
    .update(transactions)
    .set({ channel: RIGHT_CHANNEL, updatedAt: sql`now()` })
    .where(
      and(
        inArray(
          transactions.id,
          rows.map((row) => row.txId),
        ),
        eq(transactions.source, ARQ_SOURCE),
        eq(transactions.channel, WRONG_CHANNEL),
        isNull(transactions.deletedAt),
        isNull(transactions.transferGroupId),
        sql`${transactions.amountCents} > 0`,
      ),
    )
    .returning({ id: transactions.id });

  const updatedIds = updated.map((row) => row.id).sort((a, b) => a - b);

  log.info(
    {
      userId: opts.userId ?? null,
      affected: rows.length,
      changed: updatedIds.length,
      updatedIds,
      dryRun: false,
      event: "repair_arq_received_channel_applied",
    },
    "re-channelled ARQ third-party payments received to bank",
  );

  return { rows, changed: updatedIds.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Repair ARQ (gmail) payments received stored as channel='transfer'.

  bun scripts/repair-arq-received-channel.ts --dry-run    list affected rows, write nothing
  bun scripts/repair-arq-received-channel.ts              apply the repair
  --user-id=N                                             restrict to one user
  --help                                                  print this usage

Third-party receipts become channel='bank' so they count as income; receipts
whose counterparty is the user themselves (users.name or a user_aliases row)
keep 'transfer'. Manual one-off — not wired into deploy.`;

function parseArgs(argv: string[]): RepairOptions {
  let dryRun = false;
  let userId: number | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      const raw = arg.slice("--user-id=".length);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        log.error(
          { arg, event: "repair_arq_received_channel_invalid_user_id" },
          "invalid --user-id value; expected a positive integer",
        );
        process.exit(1);
      }
      userId = parsed;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      log.info({ event: "repair_arq_received_channel_help" }, USAGE);
      process.exit(0);
    }
    log.error({ arg, event: "repair_arq_received_channel_unknown_arg" }, "unknown argument");
    process.exit(1);
  }

  return { dryRun, userId };
}

async function main(): Promise<void> {
  const plan = await repairArqReceivedChannel(parseArgs(process.argv.slice(2)));
  log.info(
    {
      affected: plan.rows.length,
      changed: plan.changed,
      event: "repair_arq_received_channel_done",
    },
    plan.changed === 0 ? "repair finished with no writes" : "repair finished",
  );
}

if (import.meta.main) {
  main()
    .then(async () => {
      await db.$client.end({ timeout: 1 });
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      log.error({ err, event: "repair_arq_received_channel_failed" }, "repair failed");
      await db.$client.end({ timeout: 1 }).catch(() => void 0);
      process.exit(1);
    });
}
