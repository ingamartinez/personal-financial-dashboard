// #405: one-shot backfill that converts historical pago-tc transactions into
// transfer groups. Motivation: before #405, `tc_payment` SMS were inserted in
// savings as `category_slug="pago-tc"` (child of `deudas`, i.e. spend), which
// double-counted against the original TC purchases. This script rewrites them
// as proper transfer groups (savings debit + TC credit) so the taxonomy is
// consistent with the new ingest path.
//
// For each historical `pago-tc` tx:
//   - amount < 0 → it's a statement PAYMENT. Parse the description for the TC
//     last4 (`Pago TC *XXXX`), resolve the destination account for this user,
//     and create the paired credit leg on the TC (amount = |x|). Both legs get
//     the same transfer_group_id, channel="transfer", category_slug=null.
//   - amount > 0 → it's an abono RECEIVED on a TC. No paired leg — origin is
//     external. Just strip the category and flip channel to "transfer" so it
//     stops being counted as spend.
//   - amount = 0 → skipped with a warning.
//
// Idempotent: only processes rows where `category_slug = 'pago-tc'` AND
// `transfer_group_id IS NULL`. Safe to re-run.
//
// Relative imports on purpose — this file is overlaid to $STAGE/scripts/ on
// prod deploys (see deploy-overlay-must-track-script-imports memory).

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "migrate-pago-tc-to-transfer" });

type TxRow = {
  id: number;
  user_id: number;
  account_id: number;
  amount_cents: string;
  currency: "COP" | "USD";
  // postgres.js returns timestamptz as a string when using db.execute(sql`…`)
  // — the drizzle schema-aware select would give us a Date. We pass it back as
  // a string to avoid a needless parse.
  occurred_at: string;
  description_raw: string;
  external_id: string | null;
  raw_data: unknown;
  merchant: string | null;
};

type AccountRow = {
  id: number;
  user_id: number;
  last4s: string[] | null;
  currency: "COP" | "USD";
};

function extractTcLast4(description: string): string | null {
  // Match shapes like "Pago TC *9425", "Pago TC * 9425", tolerating whitespace.
  const m = description.match(/Pago TC \*\s*(\d{4})/i);
  return m?.[1] ?? null;
}

function findTcAccount(
  userAccounts: AccountRow[],
  last4: string,
  currency: "COP" | "USD",
): AccountRow | null {
  return (
    userAccounts.find((a) => a.currency === currency && (a.last4s ?? []).includes(last4)) ?? null
  );
}

export type MigrationReport = {
  processed: number;
  migratedPaired: number;
  migratedUnpaired: number;
  skippedNoDestination: number;
  skippedZero: number;
};

export async function migratePagoTcToTransfer(): Promise<MigrationReport> {
  const targets = await db.execute<TxRow>(sql`
    SELECT t.id, t.user_id, t.account_id, t.amount_cents::text as amount_cents,
           t.currency, t.occurred_at, t.description_raw, t.external_id, t.raw_data,
           t.merchant
    FROM transactions t
    WHERE t.category_slug = 'pago-tc'
      AND t.transfer_group_id IS NULL
  `);

  if (targets.length === 0) {
    log.info({ event: "migrate_pago_tc_noop" }, "nothing to migrate");
    return {
      processed: 0,
      migratedPaired: 0,
      migratedUnpaired: 0,
      skippedNoDestination: 0,
      skippedZero: 0,
    };
  }

  // Load every TC account for the users involved so we can resolve destinations
  // locally without re-querying per row.
  const userIds = Array.from(new Set(targets.map((r) => r.user_id)));
  const accountsResult = await db.execute<AccountRow>(sql`
    SELECT a.id, a.user_id, a.metadata->'last4s' AS last4s, a.currency
    FROM accounts a
    WHERE a.type = 'credit_card'
      AND a.user_id = ANY(${sql`ARRAY[${sql.join(
        userIds.map((u) => sql`${u}`),
        sql`, `,
      )}]::int[]`})
  `);
  const tcByUser = new Map<number, AccountRow[]>();
  for (const acc of accountsResult) {
    const list = tcByUser.get(acc.user_id) ?? [];
    // Drizzle returns JSONB as already-parsed JS values.
    list.push({ ...acc, last4s: Array.isArray(acc.last4s) ? acc.last4s : null });
    tcByUser.set(acc.user_id, list);
  }

  const report: MigrationReport = {
    processed: 0,
    migratedPaired: 0,
    migratedUnpaired: 0,
    skippedNoDestination: 0,
    skippedZero: 0,
  };

  for (const row of targets) {
    report.processed += 1;
    const amount = BigInt(row.amount_cents);

    if (amount === BigInt(0)) {
      log.warn(
        { txId: row.id, event: "migrate_pago_tc_skip_zero" },
        "tx has zero amount — skipped",
      );
      report.skippedZero += 1;
      continue;
    }

    if (amount > BigInt(0)) {
      // Abono received on TC — unpaired transfer leg. Just strip the category
      // and flip the channel. No counter-leg is inserted.
      await db.execute(sql`
        UPDATE transactions
        SET category_slug = NULL,
            channel = 'transfer'::tx_channel,
            updated_at = now()
        WHERE id = ${row.id}
      `);
      log.info(
        { txId: row.id, event: "migrate_pago_tc_unpaired" },
        "converted to unpaired transfer (abono)",
      );
      report.migratedUnpaired += 1;
      continue;
    }

    // Statement payment path: find the destination TC via description.
    const last4 = extractTcLast4(row.description_raw);
    if (!last4) {
      log.warn(
        {
          txId: row.id,
          description: row.description_raw,
          event: "migrate_pago_tc_no_last4",
        },
        "could not infer TC last4 from description — left untouched",
      );
      report.skippedNoDestination += 1;
      continue;
    }

    const userTcs = tcByUser.get(row.user_id) ?? [];
    const dest = findTcAccount(userTcs, last4, row.currency);
    if (!dest) {
      log.warn(
        {
          txId: row.id,
          last4,
          currency: row.currency,
          userId: row.user_id,
          event: "migrate_pago_tc_no_destination",
        },
        "no TC account matches last4+currency for this user — left untouched",
      );
      report.skippedNoDestination += 1;
      continue;
    }

    const transferGroupId = randomUUID();
    await db.transaction(async (trx) => {
      // Update origin leg in place — keep the row stable so any FKs on it
      // (reconciliation_decisions, ingestion_logs.resolvedTxnId) stay valid.
      await trx.execute(sql`
        UPDATE transactions
        SET category_slug = NULL,
            channel = 'transfer'::tx_channel,
            transfer_group_id = ${transferGroupId}::uuid,
            updated_at = now()
        WHERE id = ${row.id}
      `);

      // Insert the paired credit leg. Reuses the same external_id so a future
      // re-ingest of the SMS dedupes against both legs.
      await trx.execute(sql`
        INSERT INTO transactions (
          user_id, account_id, occurred_at, amount_cents, currency,
          description_raw, description_clean, merchant, category_slug,
          classification_method, classification_confidence,
          source, channel, transfer_group_id, external_id, raw_data, created_at, updated_at
        )
        VALUES (
          ${row.user_id}, ${dest.id}, ${row.occurred_at}::timestamptz,
          ${(-amount).toString()}::bigint, ${row.currency}::currency,
          ${row.description_raw}, NULL, ${row.merchant}, NULL,
          'manual'::classification_method, NULL,
          'manual'::tx_source, 'transfer'::tx_channel,
          ${transferGroupId}::uuid, ${row.external_id},
          ${JSON.stringify({
            migratedFromTxId: row.id,
            migratedAt: new Date().toISOString(),
            role: "credit",
            source: "migrate-pago-tc-to-transfer",
          })}::jsonb,
          now(), now()
        )
        ON CONFLICT (account_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
      `);
    });

    log.info(
      {
        txId: row.id,
        destAccountId: dest.id,
        transferGroupId,
        event: "migrate_pago_tc_paired",
      },
      "converted to paired transfer group",
    );
    report.migratedPaired += 1;
  }

  return report;
}

if (import.meta.main) {
  migratePagoTcToTransfer()
    .then(async (report) => {
      log.info(
        {
          ...report,
          event: "migrate_pago_tc_done",
        },
        `processed=${report.processed} paired=${report.migratedPaired} unpaired=${report.migratedUnpaired} skipped_no_dest=${report.skippedNoDestination} skipped_zero=${report.skippedZero}`,
      );
      await db.$client.end({ timeout: 1 });
      process.exit(0);
    })
    .catch(async (err) => {
      log.error({ err, event: "migrate_pago_tc_failed" }, "migration failed");
      await db.$client.end({ timeout: 1 }).catch(() => void 0);
      process.exit(1);
    });
}
