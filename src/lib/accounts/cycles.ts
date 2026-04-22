// #419: Cycle-status helpers used by the statement consolidation UI.
//
// A "cycle" here is a monthly TC closing window, labeled "YYYY-MM" after the
// month of the cut. Given an account's cutoff day we can:
//   1. Enumerate the N most recent cycles around a reference date,
//   2. Classify each as `in-progress | pending | consolidated` based on
//      today's position and on rows we've already persisted in
//      `statement_imports.kind = 'extracto_detallado'`.
//
// No DB writes. The dashboard banner + the per-account view both read from
// here; the consolidate page writes via the server actions in #418.

import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type DB } from "@/lib/db";
import type { AccountMetadata } from "@/lib/db/schema";
import { statementImports } from "@/lib/db/schema";
import { cycleAnchor } from "@/lib/finance/intereses-causados-job";

// Conservative fallback when neither the account metadata nor the linked card
// reports a cutoff. Matches the intereses-job behavior (end of month).
const FALLBACK_CUT_DAY = 31;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CycleStatus = "in-progress" | "pending" | "consolidated";

export type CycleSummary = {
  cycle: string; // "YYYY-MM"
  status: CycleStatus;
  anchor: Date; // end-of-day anchor for the cut
  consolidatedAt: Date | null;
  statementImportId: number | null;
  daysOverdue: number; // 0 for in-progress, or (today - anchor) rounded-down days for pending
};

export function resolveCutoffDay(metadata: AccountMetadata | null | undefined): number {
  const raw = metadata?.cutoffDay;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 31) {
    return FALLBACK_CUT_DAY;
  }
  return raw;
}

// Given "2026-04" returns "2026-03", wrapping December→January with year
// rollover. Used to walk backward through cycles from today.
export function previousCycle(cycle: string): string {
  const [y, m] = cycle.split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m)) {
    throw new Error(`previousCycle: invalid cycle "${cycle}"`);
  }
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

// Picks the cycle whose end-date is the first one >= `reference`. That cycle
// is "in progress" (the bank hasn't cut yet); callers walk back from there.
export function currentCycleFor(reference: Date, cutoffDay: number): string {
  const y = reference.getUTCFullYear();
  const m = reference.getUTCMonth() + 1; // 1-12
  const candidate = `${y}-${String(m).padStart(2, "0")}`;
  const anchor = cycleAnchor(candidate, cutoffDay);
  if (anchor.getTime() >= reference.getTime()) return candidate;
  // Current month already closed; next month's cycle is in progress.
  if (m === 12) return `${y + 1}-01`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

export type CyclesContext = {
  accountId: number;
  userId: number;
  metadata: AccountMetadata | null | undefined;
  // Number of cycles to return INCLUDING the current in-progress one.
  count?: number;
  // Override for deterministic tests; defaults to `new Date()`.
  now?: Date;
  database?: DB;
};

// Enumerates the `count` most recent cycles for an account (current cycle
// first). Each is annotated with its anchor, consolidation status, and how
// many days it's overdue past its cut (for the dashboard banner's >7-day
// rule).
export async function recentCycles(ctx: CyclesContext): Promise<CycleSummary[]> {
  const database = ctx.database ?? db;
  const count = ctx.count ?? 4;
  const now = ctx.now ?? new Date();
  const cutoffDay = resolveCutoffDay(ctx.metadata);

  let label = currentCycleFor(now, cutoffDay);
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    labels.push(label);
    label = previousCycle(label);
  }

  const consolidatedRows = labels.length
    ? await database
        .select({
          id: statementImports.id,
          cycle: statementImports.cycle,
          importedAt: statementImports.importedAt,
        })
        .from(statementImports)
        .where(
          and(
            eq(statementImports.userId, ctx.userId),
            eq(statementImports.accountId, ctx.accountId),
            eq(statementImports.kind, "extracto_detallado"),
            inArray(statementImports.cycle, labels),
          ),
        )
    : [];
  const consolidatedByCycle = new Map<string, { id: number; importedAt: Date }>();
  for (const row of consolidatedRows) {
    if (row.cycle) consolidatedByCycle.set(row.cycle, { id: row.id, importedAt: row.importedAt });
  }

  return labels.map((cycle) => {
    const anchor = cycleAnchor(cycle, cutoffDay);
    const hit = consolidatedByCycle.get(cycle);
    if (hit) {
      return {
        cycle,
        status: "consolidated" as const,
        anchor,
        consolidatedAt: hit.importedAt,
        statementImportId: hit.id,
        daysOverdue: 0,
      };
    }
    if (anchor.getTime() > now.getTime()) {
      return {
        cycle,
        status: "in-progress" as const,
        anchor,
        consolidatedAt: null,
        statementImportId: null,
        daysOverdue: 0,
      };
    }
    const daysOverdue = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / MS_PER_DAY));
    return {
      cycle,
      status: "pending" as const,
      anchor,
      consolidatedAt: null,
      statementImportId: null,
      daysOverdue,
    };
  });
}

export type OverdueCycleSummary = CycleSummary & {
  accountId: number;
  accountName: string;
};

// Dashboard banner helper: across all of a user's TC accounts, return every
// cycle that's pending AND more than `thresholdDays` past its cut.
export async function overdueCyclesForUser(
  userId: number,
  accounts: Array<{ id: number; name: string; metadata: AccountMetadata | null | undefined }>,
  opts: { thresholdDays?: number; now?: Date; count?: number; database?: DB } = {},
): Promise<OverdueCycleSummary[]> {
  const threshold = opts.thresholdDays ?? 7;
  const out: OverdueCycleSummary[] = [];
  for (const account of accounts) {
    const cycles = await recentCycles({
      accountId: account.id,
      userId,
      metadata: account.metadata,
      count: opts.count ?? 3,
      now: opts.now,
      database: opts.database,
    });
    for (const c of cycles) {
      if (c.status === "pending" && c.daysOverdue >= threshold) {
        out.push({ ...c, accountId: account.id, accountName: account.name });
      }
    }
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

// Most recent consolidations across the user's accounts — fuel for the
// "últimos N cierres" block on the dashboard / accounts list. Pulled in a
// single query so the UI can render a compact list without N+1.
export async function latestConsolidationsForUser(
  userId: number,
  opts: { limit?: number; database?: DB } = {},
): Promise<Array<{ accountId: number; cycle: string; importedAt: Date; id: number }>> {
  const database = opts.database ?? db;
  const rows = await database
    .select({
      id: statementImports.id,
      accountId: statementImports.accountId,
      cycle: statementImports.cycle,
      importedAt: statementImports.importedAt,
    })
    .from(statementImports)
    .where(
      and(eq(statementImports.userId, userId), eq(statementImports.kind, "extracto_detallado")),
    )
    .orderBy(desc(statementImports.importedAt))
    .limit(opts.limit ?? 10);
  return rows
    .filter((r): r is typeof r & { cycle: string } => r.cycle !== null)
    .map((r) => ({ id: r.id, accountId: r.accountId, cycle: r.cycle, importedAt: r.importedAt }));
}
