import { describe, expect, it } from "vitest";
import { computeTcAlerts, type TcCardSnapshot } from "./tc-health";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<TcCardSnapshot> = {}): TcCardSnapshot {
  return {
    cardId: "pc-test-uuid",
    kind: "physical",
    label: "Visa *1234",
    cutoffDay: null,
    currency: "COP",
    creditLimitCents: BigInt(10_000_000), // $100 000 COP
    usedCents: BigInt(0),
    utilizationPct: 0,
    daysToCutoff: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Utilization threshold tests
// ---------------------------------------------------------------------------

describe("computeTcAlerts — utilization", () => {
  it("returns [] when util is 0%", () => {
    const s = makeSnapshot({ utilizationPct: 0, usedCents: BigInt(0) });
    expect(computeTcAlerts(s)).toEqual([]);
  });

  it("returns [] when util is 79%", () => {
    const s = makeSnapshot({ utilizationPct: 79 });
    expect(computeTcAlerts(s)).toEqual([]);
  });

  it("returns ['util-80'] when util is exactly 80%", () => {
    const s = makeSnapshot({ utilizationPct: 80 });
    expect(computeTcAlerts(s)).toEqual(["util-80"]);
  });

  it("returns ['util-80'] when util is 85% (between 80 and 90)", () => {
    const s = makeSnapshot({ utilizationPct: 85 });
    expect(computeTcAlerts(s)).toEqual(["util-80"]);
  });

  it("returns ['util-90'] when util is exactly 90% — NOT util-80", () => {
    const s = makeSnapshot({ utilizationPct: 90 });
    expect(computeTcAlerts(s)).toEqual(["util-90"]);
  });

  it("returns ['util-90'] when util is 92%", () => {
    const s = makeSnapshot({ utilizationPct: 92 });
    expect(computeTcAlerts(s)).toEqual(["util-90"]);
  });

  it("returns ['util-95'] when util is exactly 95% — NOT util-90", () => {
    const s = makeSnapshot({ utilizationPct: 95 });
    expect(computeTcAlerts(s)).toEqual(["util-95"]);
  });

  it("returns ['util-95'] when util is 100%", () => {
    const s = makeSnapshot({ utilizationPct: 100 });
    expect(computeTcAlerts(s)).toEqual(["util-95"]);
  });
});

// ---------------------------------------------------------------------------
// Statement cutoff tests
// ---------------------------------------------------------------------------

describe("computeTcAlerts — statement cutoff", () => {
  it("returns [] when cutoffDay is null", () => {
    const s = makeSnapshot({ daysToCutoff: null });
    expect(computeTcAlerts(s)).toEqual([]);
  });

  it("returns [] when daysToCutoff is 4 (outside window)", () => {
    const s = makeSnapshot({ daysToCutoff: 4 });
    expect(computeTcAlerts(s)).toEqual([]);
  });

  it("returns ['statement'] when daysToCutoff is exactly 3 (boundary)", () => {
    const s = makeSnapshot({ daysToCutoff: 3 });
    expect(computeTcAlerts(s)).toContain("statement");
  });

  it("returns ['statement'] when daysToCutoff is 2", () => {
    const s = makeSnapshot({ daysToCutoff: 2 });
    expect(computeTcAlerts(s)).toContain("statement");
  });

  it("returns ['statement'] when daysToCutoff is 1", () => {
    const s = makeSnapshot({ daysToCutoff: 1 });
    expect(computeTcAlerts(s)).toContain("statement");
  });

  it("returns ['statement'] when daysToCutoff is 0 (today is cutoff day)", () => {
    const s = makeSnapshot({ daysToCutoff: 0 });
    expect(computeTcAlerts(s)).toContain("statement");
  });

  it("returns [] when daysToCutoff is -1 (cutoff passed this cycle)", () => {
    const s = makeSnapshot({ daysToCutoff: -1 });
    expect(computeTcAlerts(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Combined triggers
// ---------------------------------------------------------------------------

describe("computeTcAlerts — combined triggers", () => {
  it("returns ['util-90', 'statement'] when both fire together", () => {
    const s = makeSnapshot({ utilizationPct: 92, daysToCutoff: 2 });
    const result = computeTcAlerts(s);
    expect(result).toContain("util-90");
    expect(result).toContain("statement");
    // Util comes before statement in the return order
    expect(result.indexOf("util-90")).toBeLessThan(result.indexOf("statement"));
  });

  it("returns ['util-95', 'statement'] at 97% util + 0 days", () => {
    const s = makeSnapshot({ utilizationPct: 97, daysToCutoff: 0 });
    const result = computeTcAlerts(s);
    expect(result).toContain("util-95");
    expect(result).toContain("statement");
    expect(result).not.toContain("util-90");
    expect(result).not.toContain("util-80");
  });

  it("returns only util when cutoff is far", () => {
    const s = makeSnapshot({ utilizationPct: 83, daysToCutoff: 10 });
    const result = computeTcAlerts(s);
    expect(result).toEqual(["util-80"]);
  });

  it("returns only statement when util is low", () => {
    const s = makeSnapshot({ utilizationPct: 30, daysToCutoff: 1 });
    const result = computeTcAlerts(s);
    expect(result).toEqual(["statement"]);
  });

  it("returns [] when both util is 0% and no cutoff", () => {
    const s = makeSnapshot({
      utilizationPct: 0,
      daysToCutoff: null,
      creditLimitCents: BigInt(0),
      usedCents: BigInt(0),
    });
    expect(computeTcAlerts(s)).toEqual([]);
  });
});
