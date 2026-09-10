// #852: Rebuild recurring_description_patterns from description_raw.
//
// You cannot re-tokenize the stored `pattern` column. After the PAGO/PAGASTE
// skip, tokeniseDescription("PAGO") is null — the merchant lives in the
// original description ("Pago a EMPRESAS PUBLICAS DE MEDELLIN"), which is on
// recurring_link_observations and on linked transactions.
//
// observationCount is COUNT of distinct tx ids that produce the token, never
// a sum of old counts (summing could manufacture a trusted pattern from two
// untrusted rows that never shared a merchant). Two observations of the same
// merchant that the old tokenizer split (PAGO vs EMPRESAS) collapsing into
// EMPRESAS count=2 is legitimate — both payments were that merchant.
//
// Idempotent: the desired set is a pure function of current sources AFTER
// relink finishes. Relink may increment observation_count (recording the
// observation is correct); we re-derive from sources afterward so the stored
// count cannot drift above distinct tx ids. A second run writes nothing;
// relink still runs so a crash mid-auto-link can recover.

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { notDeleted } from "@/lib/db/helpers";
import {
  recurringDescriptionPatterns,
  recurringLinkObservations,
  transactions,
} from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { autoLinkTransaction } from "@/lib/recurring/auto-link";
import { tokeniseDescription } from "@/lib/recurring/observation-recorder";

const log = createLogger({ module: "recurring/rebuild-description-patterns" });

export type PatternSource = {
  userId: number;
  recurringId: number;
  txId: number;
  descriptionRaw: string | null | undefined;
  at: Date;
};

export type ComputedPattern = {
  userId: number;
  recurringId: number;
  pattern: string;
  observationCount: number;
  lastObservedAt: Date;
};

export type RebuildOptions = {
  userId?: number;
  dryRun?: boolean;
  /** After a real write that changed rows, re-run auto-link on unlinked txs. */
  relink?: boolean;
  database?: DB;
};

export type RebuildReport = {
  dryRun: boolean;
  computedCount: number;
  existingCount: number;
  changed: boolean;
  rowsDeleted: number;
  rowsInserted: number;
  relinkAttempted: number;
  relinked: number;
};

type Acc = {
  userId: number;
  recurringId: number;
  pattern: string;
  txIds: Set<number>;
  lastObservedAt: Date;
};

function sourceKey(userId: number, recurringId: number, txId: number): string {
  return `${userId}:${recurringId}:${txId}`;
}

function patternKey(row: { userId: number; recurringId: number; pattern: string }): string {
  return `${row.userId}:${row.recurringId}:${row.pattern}`;
}

/**
 * Pure aggregation: one output row per (user, recurring, token), count =
 * distinct tx ids. Exported so tests can pin merge semantics without a DB.
 */
export function computePatternsFromSources(sources: PatternSource[]): ComputedPattern[] {
  const acc = new Map<string, Acc>();
  for (const src of sources) {
    const token = tokeniseDescription(src.descriptionRaw);
    if (token === null) continue;
    const k = patternKey({ userId: src.userId, recurringId: src.recurringId, pattern: token });
    const existing = acc.get(k);
    if (!existing) {
      acc.set(k, {
        userId: src.userId,
        recurringId: src.recurringId,
        pattern: token,
        txIds: new Set([src.txId]),
        lastObservedAt: src.at,
      });
      continue;
    }
    existing.txIds.add(src.txId);
    if (src.at.getTime() > existing.lastObservedAt.getTime()) existing.lastObservedAt = src.at;
  }
  return [...acc.values()].map((a) => ({
    userId: a.userId,
    recurringId: a.recurringId,
    pattern: a.pattern,
    observationCount: a.txIds.size,
    lastObservedAt: a.lastObservedAt,
  }));
}

type ExistingPattern = {
  userId: number;
  recurringId: number;
  pattern: string;
  observationCount: number;
};

function snapshot(rows: { userId: number; recurringId: number; pattern: string; count: number }[]) {
  return rows
    .map((r) => `${r.userId}:${r.recurringId}:${r.pattern}:${r.count}`)
    .sort()
    .join("|");
}

function snapshotPatterns(
  rows: { userId: number; recurringId: number; pattern: string; observationCount: number }[],
) {
  return snapshot(
    rows.map((r) => ({
      userId: r.userId,
      recurringId: r.recurringId,
      pattern: r.pattern,
      count: r.observationCount,
    })),
  );
}

async function loadSources(userId: number | undefined, database: DB): Promise<PatternSource[]> {
  const obsBase = database
    .select({
      userId: recurringLinkObservations.userId,
      recurringId: recurringLinkObservations.recurringId,
      txId: recurringLinkObservations.txId,
      descriptionRaw: recurringLinkObservations.descriptionRaw,
      at: recurringLinkObservations.observedAt,
    })
    .from(recurringLinkObservations);
  const obsRows =
    userId === undefined
      ? await obsBase
      : await obsBase.where(eq(recurringLinkObservations.userId, userId));

  const txBase = database
    .select({
      userId: transactions.userId,
      recurringId: transactions.recurringId,
      txId: transactions.id,
      descriptionRaw: transactions.descriptionRaw,
      at: transactions.occurredAt,
    })
    .from(transactions);
  const txRows =
    userId === undefined
      ? await txBase.where(
          and(isNotNull(transactions.recurringId), notDeleted(transactions.deletedAt)),
        )
      : await txBase.where(
          and(
            isNotNull(transactions.recurringId),
            notDeleted(transactions.deletedAt),
            eq(transactions.userId, userId),
          ),
        );

  const byKey = new Map<string, PatternSource>();
  for (const row of obsRows) {
    byKey.set(sourceKey(row.userId, row.recurringId, row.txId), row);
  }
  for (const row of txRows) {
    if (row.recurringId === null) continue;
    const src: PatternSource = {
      userId: row.userId,
      recurringId: row.recurringId,
      txId: row.txId,
      descriptionRaw: row.descriptionRaw,
      at: row.at,
    };
    const k = sourceKey(src.userId, src.recurringId, src.txId);
    if (!byKey.has(k)) byKey.set(k, src);
  }
  return [...byKey.values()];
}

async function loadExisting(userId: number | undefined, database: DB): Promise<ExistingPattern[]> {
  const existingBase = database
    .select({
      userId: recurringDescriptionPatterns.userId,
      recurringId: recurringDescriptionPatterns.recurringId,
      pattern: recurringDescriptionPatterns.pattern,
      observationCount: recurringDescriptionPatterns.observationCount,
    })
    .from(recurringDescriptionPatterns);
  return userId === undefined
    ? await existingBase
    : await existingBase.where(eq(recurringDescriptionPatterns.userId, userId));
}

async function replacePatterns(
  database: DB,
  computed: ComputedPattern[],
  existing: ExistingPattern[],
  userId: number | undefined,
): Promise<{ rowsDeleted: number; rowsInserted: number }> {
  const recurringIds = [
    ...new Set([...existing.map((r) => r.recurringId), ...computed.map((r) => r.recurringId)]),
  ];
  let rowsDeleted = 0;
  let rowsInserted = 0;

  await database.transaction(async (trx) => {
    if (recurringIds.length > 0) {
      const delFilter = [
        inArray(recurringDescriptionPatterns.recurringId, recurringIds),
        ...(userId === undefined ? [] : [eq(recurringDescriptionPatterns.userId, userId)]),
      ];
      const deleted = await trx
        .delete(recurringDescriptionPatterns)
        .where(and(...delFilter))
        .returning({ id: recurringDescriptionPatterns.id });
      rowsDeleted = deleted.length;
    }
    if (computed.length > 0) {
      await trx.insert(recurringDescriptionPatterns).values(
        computed.map((r) => ({
          userId: r.userId,
          recurringId: r.recurringId,
          pattern: r.pattern,
          observationCount: r.observationCount,
          lastObservedAt: r.lastObservedAt,
        })),
      );
      rowsInserted = computed.length;
    }
  });

  return { rowsDeleted, rowsInserted };
}

export async function rebuildDescriptionPatterns(
  opts: RebuildOptions = {},
): Promise<RebuildReport> {
  const database = opts.database ?? defaultDb;
  const dryRun = opts.dryRun ?? false;
  const relink = opts.relink ?? true;

  const existing = await loadExisting(opts.userId, database);
  const sources = await loadSources(opts.userId, database);
  const computed = computePatternsFromSources(sources);

  const changed = snapshotPatterns(existing) !== snapshotPatterns(computed);

  log.info(
    {
      event: "rebuild_description_patterns_plan",
      dryRun,
      userId: opts.userId ?? null,
      existingCount: existing.length,
      computedCount: computed.length,
      sourceCount: sources.length,
      changed,
    },
    "rebuild description patterns planned",
  );

  const report: RebuildReport = {
    dryRun,
    computedCount: computed.length,
    existingCount: existing.length,
    changed,
    rowsDeleted: 0,
    rowsInserted: 0,
    relinkAttempted: 0,
    relinked: 0,
  };

  if (dryRun) {
    return report;
  }

  if (changed) {
    const written = await replacePatterns(database, computed, existing, opts.userId);
    report.rowsDeleted = written.rowsDeleted;
    report.rowsInserted = written.rowsInserted;

    log.info(
      {
        event: "rebuild_description_patterns_written",
        rowsDeleted: report.rowsDeleted,
        rowsInserted: report.rowsInserted,
      },
      "rebuild description patterns written",
    );
  }

  if (!relink) return report;

  const userIds = [
    ...new Set([
      ...existing.map((r) => r.userId),
      ...computed.map((r) => r.userId),
      ...(opts.userId === undefined ? [] : [opts.userId]),
    ]),
  ];

  for (const userId of userIds) {
    const unlinked = await database
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNull(transactions.recurringId),
          notDeleted(transactions.deletedAt),
        ),
      );
    for (const tx of unlinked) {
      report.relinkAttempted += 1;
      const result = await autoLinkTransaction(userId, tx.id, database);
      if (result.status === "linked") report.relinked += 1;
    }
  }

  log.info(
    {
      event: "rebuild_description_patterns_relinked",
      relinkAttempted: report.relinkAttempted,
      relinked: report.relinked,
    },
    "rebuild description patterns relink finished",
  );

  // Relink records observations and increments observation_count. Re-derive
  // from sources so the stored count stays COUNT(distinct tx_id), not
  // "derived + however many links this run just recorded".
  const sourcesAfter = await loadSources(opts.userId, database);
  const computedAfter = computePatternsFromSources(sourcesAfter);
  const existingAfter = await loadExisting(opts.userId, database);
  if (snapshotPatterns(existingAfter) !== snapshotPatterns(computedAfter)) {
    const reconciled = await replacePatterns(database, computedAfter, existingAfter, opts.userId);
    log.info(
      {
        event: "rebuild_description_patterns_relink_reconciled",
        rowsDeleted: reconciled.rowsDeleted,
        rowsInserted: reconciled.rowsInserted,
      },
      "rebuild description patterns re-derived after relink",
    );
  }

  return report;
}
