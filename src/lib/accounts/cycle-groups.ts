// #431: Collapse linked multi-currency TC accounts (e.g. Mastercard
// Internacional COP + USD) into a single UI block so the user sees one row
// per (plástico, cycle) instead of duplicated pending nags.
//
// The backend still writes one `statement_imports` row per account — that's
// correct, the extract has one sheet per currency. The UI just needs to
// know that a single extract satisfies the whole plastic's cycle, and the
// dashboard banner must not double-count. Both consumers share this helper
// so the semantics stay in one place.

import type { CycleStatus, CycleSummary } from "@/lib/accounts/cycles";

// Ordered from "needs most attention" to "needs none". When two siblings of
// the same plastic disagree on a cycle (e.g. one currency was consolidated
// and the other wasn't), the group inherits the more urgent status. Kept as
// a module-level array so the precedence is readable in one line.
const STATUS_PRECEDENCE: readonly CycleStatus[] = [
  "pending",
  "in-progress",
  "consolidated",
  "no-activity",
] as const;

function rank(status: CycleStatus): number {
  return STATUS_PRECEDENCE.indexOf(status);
}

// `coalesceStatus` picks the worst-case status from a list of siblings for
// the same cycle label. Public for testability.
export function coalesceStatus(statuses: readonly CycleStatus[]): CycleStatus {
  if (statuses.length === 0) return "consolidated"; // defensive; coalesce([]) never called in practice
  let best = statuses[0];
  for (let i = 1; i < statuses.length; i++) {
    if (rank(statuses[i]) < rank(best)) best = statuses[i];
  }
  return best;
}

export type GroupAccount = {
  id: number;
  name: string;
  currency: string;
  institution: string | null;
  institutionSlug: string | null;
  metadata: unknown;
  physicalCardId: string | null;
};

export type AccountWithCycles<A extends GroupAccount = GroupAccount> = {
  account: A;
  cycles: CycleSummary[];
};

export type CoalescedCycle = {
  cycle: string;
  status: CycleStatus;
  anchor: Date;
  daysOverdue: number;
  consolidatedAt: Date | null;
  statementImportId: number | null;
  // Currencies present in this cycle's siblings, in the order they appeared.
  // Used to render the "COP + USD · 1 extracto, 2 hojas" subtitle.
  currencies: string[];
};

export type CycleGroup<A extends GroupAccount = GroupAccount> = {
  // The plastic key — `physicalCardId` for linked groups, or `single:<id>`
  // for standalone accounts. Stable id for React keys.
  key: string;
  // All accounts linked to the same plastic. Single-currency accounts get a
  // one-element array. Ordered with COP first when present.
  accounts: A[];
  // Account whose id is used in `/consolidate/<id>/<cycle>` links. Convention
  // from the issue: COP account wins; otherwise the first sibling.
  primaryAccountId: number;
  // Cycles coalesced across siblings (same label dedup'd into one row).
  cycles: CoalescedCycle[];
  // `true` when there are 2+ linked accounts sharing the plastic — UI uses
  // this to show the multi-sheet subtitle.
  isMultiCurrency: boolean;
};

// Sort helper: COP before USD before other currencies. Deterministic so the
// "primary" pick and the currencies list in the subtitle are stable.
function currencyRank(c: string): number {
  if (c === "COP") return 0;
  if (c === "USD") return 1;
  return 2;
}

export function groupAccountsForConsolidation<A extends GroupAccount>(
  perAccount: AccountWithCycles<A>[],
): CycleGroup<A>[] {
  // Group by physicalCardId. Accounts without one are their own group.
  const byPcId = new Map<string, AccountWithCycles<A>[]>();
  const singletons: AccountWithCycles<A>[] = [];
  for (const item of perAccount) {
    if (item.account.physicalCardId) {
      const existing = byPcId.get(item.account.physicalCardId);
      if (existing) existing.push(item);
      else byPcId.set(item.account.physicalCardId, [item]);
    } else {
      singletons.push(item);
    }
  }

  const groups: CycleGroup<A>[] = [];

  // Keep input order: groups ordered by the FIRST appearance of each plastic.
  const seen = new Set<string>();
  for (const item of perAccount) {
    if (item.account.physicalCardId) {
      if (seen.has(item.account.physicalCardId)) continue;
      seen.add(item.account.physicalCardId);
      const siblings = byPcId.get(item.account.physicalCardId)!;
      // Sort siblings: COP first, then USD, then others (stable by currency rank).
      const sorted = [...siblings].sort(
        (a, b) => currencyRank(a.account.currency) - currencyRank(b.account.currency),
      );
      groups.push(buildGroup(item.account.physicalCardId, sorted));
    } else {
      groups.push(buildGroup(`single:${item.account.id}`, [item]));
    }
  }
  // Consume singletons iteration already covered them above; avoid double-push.
  // (Left in loop-form defensively — any account with physicalCardId=null is
  // not in byPcId, so the `else` branch handles it inline.)
  void singletons;

  return groups;
}

function buildGroup<A extends GroupAccount>(
  key: string,
  siblings: AccountWithCycles<A>[],
): CycleGroup<A> {
  const accounts = siblings.map((s) => s.account);
  const primary = accounts.find((a) => a.currency === "COP") ?? accounts[0];
  const isMultiCurrency = siblings.length > 1;

  // Walk every cycle label the siblings emit (in order from the first sibling
  // — they all share the same cutoff day by definition, so their cycle labels
  // match). Coalesce status across siblings at the same label.
  const [first, ...rest] = siblings;
  const cycles: CoalescedCycle[] = first.cycles.map((c) => {
    const peers = rest.map((s) => s.cycles.find((pc) => pc.cycle === c.cycle) ?? c);
    const statuses = [c.status, ...peers.map((p) => p.status)];
    const status = coalesceStatus(statuses);
    // `daysOverdue` is driven by the coalesced status: if the group is
    // pending, use the max daysOverdue among the pending siblings. If
    // consolidated, 0. If no-activity or in-progress, 0.
    let daysOverdue = 0;
    if (status === "pending") {
      const allCycles = [c, ...peers];
      daysOverdue = allCycles.reduce((max, x) => (x.daysOverdue > max ? x.daysOverdue : max), 0);
    }
    // `consolidatedAt` / `statementImportId` — pick from any sibling that's
    // consolidated (prefer primary). Useful when the group is consolidated
    // as a whole or when viewing a specific account's run.
    const consolidatedSiblings = [c, ...peers].filter((x) => x.consolidatedAt !== null);
    const consolidatedAt = consolidatedSiblings[0]?.consolidatedAt ?? null;
    const statementImportId = consolidatedSiblings[0]?.statementImportId ?? null;

    const currencies: string[] = [];
    for (const s of siblings) {
      if (!currencies.includes(s.account.currency)) currencies.push(s.account.currency);
    }

    return {
      cycle: c.cycle,
      status,
      anchor: c.anchor,
      daysOverdue,
      consolidatedAt,
      statementImportId,
      currencies,
    };
  });

  return {
    key,
    accounts,
    primaryAccountId: primary.id,
    cycles,
    isMultiCurrency,
  };
}

export type OverdueWithCard = {
  cycle: string;
  accountId: number;
  accountName: string;
  daysOverdue: number;
  physicalCardId: string | null;
  currency: string;
};

export type DedupedOverdue = {
  cycle: string;
  // Label to show ("Bancolombia Mastercard *7291"); for standalone accounts
  // this is the regular account name.
  label: string;
  // Account id used for the "Consolidar ahora" link (COP preferred).
  primaryAccountId: number;
  // Max daysOverdue across siblings of the same plastic on this cycle.
  daysOverdue: number;
};

// Dedupe an overdue feed by `(physicalCardId, cycle)`. Accounts without a
// physicalCardId stay one-row-per-account (their key is `single:<id>`).
// `label` is the account name of the chosen primary sibling — the caller
// already has the name string, so this helper doesn't re-query.
//
// `opts.copAccountByPcId` lets the caller pass a `physicalCardId → COP
// accountId` map so the primary link resolves to the plastic's COP account
// EVEN WHEN the COP account isn't in the overdue feed (e.g. COP side is
// `no-activity`, only USD is pending). Without the map the helper falls
// back to the first sibling present in the feed. This keeps the Status
// widget and the dashboard banner pointing to the same destination.
export function dedupeOverdueByPhysicalCard(
  rows: OverdueWithCard[],
  opts: { copAccountByPcId?: Map<string, number>; copNameByPcId?: Map<string, string> } = {},
): DedupedOverdue[] {
  type Bucket = { rows: OverdueWithCard[]; key: string };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const key = `${r.physicalCardId ?? `single:${r.accountId}`}::${r.cycle}`;
    const existing = buckets.get(key);
    if (existing) existing.rows.push(r);
    else buckets.set(key, { rows: [r], key });
  }
  const out: DedupedOverdue[] = [];
  for (const b of buckets.values()) {
    const copRowInFeed = b.rows.find((r) => r.currency === "COP");
    const fallback = b.rows[0];
    const pcId = fallback.physicalCardId;
    const copIdFromMap = pcId ? opts.copAccountByPcId?.get(pcId) : undefined;
    const copNameFromMap = pcId ? opts.copNameByPcId?.get(pcId) : undefined;
    const primaryAccountId = copRowInFeed?.accountId ?? copIdFromMap ?? fallback.accountId;
    const label = copRowInFeed?.accountName ?? copNameFromMap ?? fallback.accountName;
    const daysOverdue = b.rows.reduce((max, r) => (r.daysOverdue > max ? r.daysOverdue : max), 0);
    out.push({
      cycle: fallback.cycle,
      label,
      primaryAccountId,
      daysOverdue,
    });
  }
  // Preserve the input's "most overdue first" ordering — sort by daysOverdue desc.
  out.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return out;
}
