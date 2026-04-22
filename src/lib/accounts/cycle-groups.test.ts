// #431: Unit tests for the plastic-grouping helpers. Pure functions, no DB.

import { describe, expect, it } from "vitest";

import type { CycleStatus, CycleSummary } from "@/lib/accounts/cycles";
import {
  coalesceStatus,
  dedupeOverdueByPhysicalCard,
  groupAccountsForConsolidation,
  type AccountWithCycles,
  type GroupAccount,
  type OverdueWithCard,
} from "@/lib/accounts/cycle-groups";

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 23, 0, 0, 0));
}

function cycle(label: string, status: CycleStatus, daysOverdue = 0): CycleSummary {
  const [y, m] = label.split("-").map(Number);
  return {
    cycle: label,
    status,
    anchor: utcDate(y, m, 30),
    daysOverdue,
    consolidatedAt: status === "consolidated" ? utcDate(y, m, 30) : null,
    statementImportId: status === "consolidated" ? 100 : null,
  };
}

function account(
  id: number,
  name: string,
  currency: string,
  physicalCardId: string | null,
): GroupAccount {
  return {
    id,
    name,
    currency,
    institution: "Bancolombia",
    institutionSlug: "bancolombia",
    metadata: null,
    physicalCardId,
  };
}

describe("coalesceStatus (#431)", () => {
  it("picks pending when any sibling is pending", () => {
    expect(coalesceStatus(["pending", "consolidated"])).toBe("pending");
    expect(coalesceStatus(["consolidated", "pending"])).toBe("pending");
    expect(coalesceStatus(["pending", "no-activity"])).toBe("pending");
  });

  it("falls through the precedence when no pending", () => {
    expect(coalesceStatus(["in-progress", "consolidated"])).toBe("in-progress");
    expect(coalesceStatus(["consolidated", "no-activity"])).toBe("consolidated");
  });

  it("returns the single value when siblings agree", () => {
    expect(coalesceStatus(["consolidated", "consolidated"])).toBe("consolidated");
    expect(coalesceStatus(["no-activity", "no-activity"])).toBe("no-activity");
  });
});

describe("groupAccountsForConsolidation (#431)", () => {
  it("groups accounts sharing a physicalCardId into one CycleGroup", () => {
    const a: AccountWithCycles = {
      account: account(10, "Bancolombia Mastercard *7291", "COP", "pc-1"),
      cycles: [cycle("2026-04", "in-progress"), cycle("2026-03", "pending", 21)],
    };
    const b: AccountWithCycles = {
      account: account(11, "Bancolombia Mastercard *7291", "USD", "pc-1"),
      cycles: [cycle("2026-04", "in-progress"), cycle("2026-03", "pending", 21)],
    };
    const groups = groupAccountsForConsolidation([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("pc-1");
    expect(groups[0].isMultiCurrency).toBe(true);
    expect(groups[0].accounts.map((x) => x.currency)).toEqual(["COP", "USD"]);
    expect(groups[0].primaryAccountId).toBe(10); // COP wins.
    expect(groups[0].cycles[1].cycle).toBe("2026-03");
    expect(groups[0].cycles[1].status).toBe("pending");
    expect(groups[0].cycles[1].currencies).toEqual(["COP", "USD"]);
    expect(groups[0].cycles[1].daysOverdue).toBe(21);
  });

  it("keeps single-currency accounts as single-member groups", () => {
    const a: AccountWithCycles = {
      account: account(5, "Bancolombia Visa *2575", "COP", null),
      cycles: [cycle("2026-04", "in-progress"), cycle("2026-03", "consolidated")],
    };
    const groups = groupAccountsForConsolidation([a]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("single:5");
    expect(groups[0].isMultiCurrency).toBe(false);
    expect(groups[0].accounts).toHaveLength(1);
    expect(groups[0].primaryAccountId).toBe(5);
    expect(groups[0].cycles[0].currencies).toEqual(["COP"]);
  });

  it("coalesces mismatched sibling statuses to the worst case", () => {
    const a: AccountWithCycles = {
      account: account(10, "MC", "COP", "pc-1"),
      cycles: [cycle("2026-03", "consolidated")],
    };
    const b: AccountWithCycles = {
      account: account(11, "MC", "USD", "pc-1"),
      cycles: [cycle("2026-03", "pending", 52)],
    };
    const group = groupAccountsForConsolidation([a, b])[0];
    expect(group.cycles[0].status).toBe("pending");
    expect(group.cycles[0].daysOverdue).toBe(52);
  });

  it("prefers COP sibling as primaryAccountId regardless of input order", () => {
    const usd: AccountWithCycles = {
      account: account(20, "Amex", "USD", "pc-x"),
      cycles: [cycle("2026-03", "pending", 30)],
    };
    const cop: AccountWithCycles = {
      account: account(21, "Amex", "COP", "pc-x"),
      cycles: [cycle("2026-03", "pending", 30)],
    };
    const group = groupAccountsForConsolidation([usd, cop])[0];
    expect(group.primaryAccountId).toBe(21); // COP wins.
    expect(group.accounts[0].currency).toBe("COP");
  });

  it("falls back to first sibling when no COP is present", () => {
    const a: AccountWithCycles = {
      account: account(30, "Exotic", "USD", "pc-y"),
      cycles: [cycle("2026-03", "pending", 10)],
    };
    const b: AccountWithCycles = {
      account: account(31, "Exotic", "EUR", "pc-y"),
      cycles: [cycle("2026-03", "pending", 10)],
    };
    const group = groupAccountsForConsolidation([a, b])[0];
    expect(group.primaryAccountId).toBe(30);
  });

  it("preserves group order by first appearance of each plastic", () => {
    const mcCop: AccountWithCycles = {
      account: account(10, "MC", "COP", "pc-mc"),
      cycles: [cycle("2026-03", "pending", 5)],
    };
    const visa: AccountWithCycles = {
      account: account(5, "Visa", "COP", null),
      cycles: [cycle("2026-03", "consolidated")],
    };
    const mcUsd: AccountWithCycles = {
      account: account(11, "MC", "USD", "pc-mc"),
      cycles: [cycle("2026-03", "pending", 5)],
    };
    const groups = groupAccountsForConsolidation([mcCop, visa, mcUsd]);
    // MC plastic appears before Visa in the input; its group must come first.
    expect(groups.map((g) => g.key)).toEqual(["pc-mc", "single:5"]);
  });
});

describe("dedupeOverdueByPhysicalCard (#431)", () => {
  it("collapses (plastic, cycle) duplicates into one row", () => {
    const rows: OverdueWithCard[] = [
      {
        cycle: "2026-03",
        accountId: 10,
        accountName: "Bancolombia Mastercard *7291",
        daysOverdue: 21,
        physicalCardId: "pc-1",
        currency: "COP",
      },
      {
        cycle: "2026-03",
        accountId: 11,
        accountName: "Bancolombia Mastercard *7291",
        daysOverdue: 21,
        physicalCardId: "pc-1",
        currency: "USD",
      },
    ];
    const out = dedupeOverdueByPhysicalCard(rows);
    expect(out).toHaveLength(1);
    expect(out[0].primaryAccountId).toBe(10); // COP wins.
    expect(out[0].label).toBe("Bancolombia Mastercard *7291");
    expect(out[0].cycle).toBe("2026-03");
  });

  it("keeps separate rows for different cycles on the same plastic", () => {
    const rows: OverdueWithCard[] = [
      {
        cycle: "2026-03",
        accountId: 10,
        accountName: "MC",
        daysOverdue: 21,
        physicalCardId: "pc-1",
        currency: "COP",
      },
      {
        cycle: "2026-02",
        accountId: 10,
        accountName: "MC",
        daysOverdue: 52,
        physicalCardId: "pc-1",
        currency: "COP",
      },
    ];
    const out = dedupeOverdueByPhysicalCard(rows);
    expect(out).toHaveLength(2);
    expect(out[0].cycle).toBe("2026-02"); // most-overdue first
    expect(out[1].cycle).toBe("2026-03");
  });

  it("keeps standalone accounts (no physicalCardId) as their own buckets", () => {
    const rows: OverdueWithCard[] = [
      {
        cycle: "2026-03",
        accountId: 5,
        accountName: "Visa *2575",
        daysOverdue: 10,
        physicalCardId: null,
        currency: "COP",
      },
      {
        cycle: "2026-03",
        accountId: 6,
        accountName: "Other",
        daysOverdue: 8,
        physicalCardId: null,
        currency: "COP",
      },
    ];
    const out = dedupeOverdueByPhysicalCard(rows);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.primaryAccountId).sort()).toEqual([5, 6]);
  });

  it("takes max daysOverdue across siblings", () => {
    const rows: OverdueWithCard[] = [
      {
        cycle: "2026-03",
        accountId: 10,
        accountName: "MC",
        daysOverdue: 10,
        physicalCardId: "pc-1",
        currency: "COP",
      },
      {
        cycle: "2026-03",
        accountId: 11,
        accountName: "MC",
        daysOverdue: 30,
        physicalCardId: "pc-1",
        currency: "USD",
      },
    ];
    const out = dedupeOverdueByPhysicalCard(rows);
    expect(out[0].daysOverdue).toBe(30);
  });

  it("uses the COP map fallback when the COP sibling isn't in the overdue feed", () => {
    // Scenario: Mastercard COP is `no-activity` for 2026-02 (not in overdue
    // feed) but USD is `pending`. The banner link should still resolve to
    // the COP account so it matches the Status widget.
    const rows: OverdueWithCard[] = [
      {
        cycle: "2026-02",
        accountId: 11,
        accountName: "Bancolombia Mastercard *7291",
        daysOverdue: 52,
        physicalCardId: "pc-1",
        currency: "USD",
      },
    ];
    const out = dedupeOverdueByPhysicalCard(rows, {
      copAccountByPcId: new Map([["pc-1", 10]]),
      copNameByPcId: new Map([["pc-1", "Bancolombia Mastercard *7291"]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0].primaryAccountId).toBe(10);
    expect(out[0].label).toBe("Bancolombia Mastercard *7291");
  });

  it("counts the banner message correctly (plásticos, not accounts)", () => {
    // The regression from #431: Mastercard with 2 pending cycles (COP+USD)
    // had the banner saying "4 ciclos pendientes". After dedup it says "2".
    const rows: OverdueWithCard[] = [
      {
        cycle: "2026-03",
        accountId: 10,
        accountName: "MC",
        daysOverdue: 21,
        physicalCardId: "pc-1",
        currency: "COP",
      },
      {
        cycle: "2026-03",
        accountId: 11,
        accountName: "MC",
        daysOverdue: 21,
        physicalCardId: "pc-1",
        currency: "USD",
      },
      {
        cycle: "2026-02",
        accountId: 10,
        accountName: "MC",
        daysOverdue: 52,
        physicalCardId: "pc-1",
        currency: "COP",
      },
      {
        cycle: "2026-02",
        accountId: 11,
        accountName: "MC",
        daysOverdue: 52,
        physicalCardId: "pc-1",
        currency: "USD",
      },
    ];
    const out = dedupeOverdueByPhysicalCard(rows);
    expect(out).toHaveLength(2);
  });
});
