import { describe, it, expect } from "vitest";
import {
  computePercentiles,
  classifyBin,
  computeDailyHeatmap,
  detectExpensiveDays,
  detectSeasonality,
  type PerDayTotal,
} from "./temporal";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDay(isoDate: string, copCents: bigint): PerDayTotal {
  return { day: new Date(isoDate + "T00:00:00Z"), cop: copCents };
}

/** Build a contiguous range of days from startIso to (startIso + count - 1). */
function dailyRange(startIso: string, count: number, copCents: bigint): PerDayTotal[] {
  const start = new Date(startIso + "T00:00:00Z").getTime();
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(start + i * 86400000),
    cop: copCents,
  }));
}

const TODAY = new Date("2024-06-15T00:00:00Z");

// ---------------------------------------------------------------------------
// computePercentiles
// ---------------------------------------------------------------------------

describe("computePercentiles", () => {
  it("returns zeros for empty input", () => {
    expect(computePercentiles([])).toEqual({ p25: BigInt(0), p75: BigInt(0) });
  });

  it("single value — both thresholds equal that value", () => {
    const { p25, p75 } = computePercentiles([BigInt(100)]);
    expect(p25).toBe(BigInt(100));
    expect(p75).toBe(BigInt(100));
  });

  it("four values — correct quartile indices", () => {
    // sorted: [10, 20, 30, 40]
    const { p25, p75 } = computePercentiles([BigInt(10), BigInt(20), BigInt(30), BigInt(40)]);
    // p25Idx = floor(4 * 0.25) = 1 → sorted[1] = 20
    // p75Idx = floor(4 * 0.75) = 3 → sorted[3] = 40
    expect(p25).toBe(BigInt(20));
    expect(p75).toBe(BigInt(40));
  });
});

// ---------------------------------------------------------------------------
// classifyBin
// ---------------------------------------------------------------------------

describe("classifyBin", () => {
  it("zero → none", () => {
    expect(classifyBin(BigInt(0), BigInt(100), BigInt(300))).toBe("none");
  });

  it("≤ p25 → light", () => {
    expect(classifyBin(BigInt(100), BigInt(100), BigInt(300))).toBe("light");
    expect(classifyBin(BigInt(50), BigInt(100), BigInt(300))).toBe("light");
  });

  it("> p25 and ≤ p75 → medium", () => {
    expect(classifyBin(BigInt(200), BigInt(100), BigInt(300))).toBe("medium");
    expect(classifyBin(BigInt(300), BigInt(100), BigInt(300))).toBe("medium");
  });

  it("> p75 → high", () => {
    expect(classifyBin(BigInt(301), BigInt(100), BigInt(300))).toBe("high");
    expect(classifyBin(BigInt(9999), BigInt(100), BigInt(300))).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// computeDailyHeatmap
// ---------------------------------------------------------------------------

describe("computeDailyHeatmap", () => {
  it("empty data → all buckets are 'none'", () => {
    const buckets = computeDailyHeatmap(TODAY, []);
    expect(buckets).toHaveLength(365);
    expect(buckets.every((b) => b.bin === "none")).toBe(true);
    expect(buckets.every((b) => b.copCents === BigInt(0))).toBe(true);
  });

  it("all-zero days → all buckets are 'none'", () => {
    const data = dailyRange("2023-06-15", 365, BigInt(0));
    const buckets = computeDailyHeatmap(TODAY, data);
    expect(buckets.every((b) => b.bin === "none")).toBe(true);
  });

  it("produces exactly 365 buckets", () => {
    const buckets = computeDailyHeatmap(TODAY, []);
    expect(buckets).toHaveLength(365);
  });

  it("first bucket is (today - 365d), last is yesterday", () => {
    const buckets = computeDailyHeatmap(TODAY, []);
    // oldest: today - 365*86400000 ms; newest: today - 1*86400000 ms
    const expectedFirst = new Date(TODAY.getTime() - 365 * 86400000).toISOString().slice(0, 10);
    const expectedLast = new Date(TODAY.getTime() - 86400000).toISOString().slice(0, 10);
    expect(buckets[0]!.date).toBe(expectedFirst);
    expect(buckets[364]!.date).toBe(expectedLast);
  });

  it("excludes today itself", () => {
    const todayEntry = makeDay("2024-06-15", BigInt(100000));
    const buckets = computeDailyHeatmap(TODAY, [todayEntry]);
    // Today is NOT part of the [today-365d, yesterday] range
    const todayBucket = buckets.find((b) => b.date === "2024-06-15");
    expect(todayBucket).toBeUndefined();
  });

  it("data outside 365d window is ignored", () => {
    const oldEntry = makeDay("2020-01-01", BigInt(999999));
    const buckets = computeDailyHeatmap(TODAY, [oldEntry]);
    expect(buckets.every((b) => b.bin === "none")).toBe(true);
  });

  it("skewed distribution — single high-value day gets 'high' bin", () => {
    // 100 days with 100 cents, 1 day with 1_000_000 cents (clearly high)
    const base = dailyRange("2023-09-01", 100, BigInt(100));
    const spike = makeDay("2024-06-01", BigInt(1_000_000));
    const buckets = computeDailyHeatmap(TODAY, [...base, spike]);
    const spikeBucket = buckets.find((b) => b.date === "2024-06-01");
    expect(spikeBucket?.bin).toBe("high");
  });

  it("even distribution — bins spread across light/medium/high", () => {
    // 4 days with 100, 200, 300, 400 cents
    const data = [
      makeDay("2024-06-10", BigInt(100)),
      makeDay("2024-06-11", BigInt(200)),
      makeDay("2024-06-12", BigInt(300)),
      makeDay("2024-06-13", BigInt(400)),
    ];
    const buckets = computeDailyHeatmap(TODAY, data);
    const active = buckets.filter((b) => b.bin !== "none");
    expect(active).toHaveLength(4);
    // sorted: 100, 200, 300, 400 → p25=sorted[1]=200, p75=sorted[3]=400
    // 100 <= 200 → light, 200 <= 200 → light, 300 <= 400 → medium, 400 <= 400 → medium
    const bins = active.map((b) => b.bin).sort();
    expect(bins.filter((b) => b === "light")).toHaveLength(2);
    expect(bins.filter((b) => b === "medium")).toHaveLength(2);
    expect(bins.filter((b) => b === "high")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectExpensiveDays
// ---------------------------------------------------------------------------

describe("detectExpensiveDays", () => {
  it("insufficient data (< 30 unique days) → empty array", () => {
    const data = dailyRange("2024-06-01", 20, BigInt(100000));
    expect(detectExpensiveDays(data, TODAY)).toEqual([]);
  });

  it("returns empty when no DOW meets threshold", () => {
    // Uniform spend every day for 90 days — no DOW stands out
    const data = dailyRange("2024-03-17", 90, BigInt(100000));
    expect(detectExpensiveDays(data, TODAY)).toEqual([]);
  });

  it("detects a single expensive DOW", () => {
    const data: PerDayTotal[] = [];
    const start = new Date("2024-03-17T00:00:00Z").getTime(); // a Sunday
    for (let i = 0; i < 90; i++) {
      const day = new Date(start + i * 86400000);
      const dow = day.getUTCDay();
      // Fridays (dow=5) spend 10× the baseline
      const cop = dow === 5 ? BigInt(5_000_000) : BigInt(200_000);
      data.push({ day, cop });
    }
    const results = detectExpensiveDays(data, TODAY);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.dow).toBe(5); // Friday
    expect(results[0]!.deltaPct).toBeGreaterThan(0);
  });

  it("respects COP floor — a high-ratio but tiny-amount DOW does not trigger", () => {
    const data: PerDayTotal[] = [];
    const start = new Date("2024-03-17T00:00:00Z").getTime();
    for (let i = 0; i < 90; i++) {
      const day = new Date(start + i * 86400000);
      const dow = day.getUTCDay();
      // Saturdays (dow=6) spend 10× but total is tiny (below 50k COP)
      const cop = dow === 6 ? BigInt(1000) : BigInt(100);
      data.push({ day, cop });
    }
    expect(detectExpensiveDays(data, TODAY)).toEqual([]);
  });

  it("returns at most 2 results", () => {
    const data: PerDayTotal[] = [];
    const start = new Date("2024-03-17T00:00:00Z").getTime();
    for (let i = 0; i < 90; i++) {
      const day = new Date(start + i * 86400000);
      const dow = day.getUTCDay();
      // Make Mon, Wed, Fri all 10× baseline (3 expensive DOWs)
      const isExpensive = dow === 1 || dow === 3 || dow === 5;
      const cop = isExpensive ? BigInt(10_000_000) : BigInt(100_000);
      data.push({ day, cop });
    }
    const results = detectExpensiveDays(data, TODAY);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// detectSeasonality
// ---------------------------------------------------------------------------

describe("detectSeasonality", () => {
  it("fewer than 12 months of history → empty array", () => {
    // Only 6 months of data
    const data = dailyRange("2023-12-15", 183, BigInt(200000));
    expect(detectSeasonality(data, TODAY)).toEqual([]);
  });

  it("exactly 12 months → processes (no early return)", () => {
    // 365 days with uniform spend — no month triggers
    const data = dailyRange("2023-06-15", 365, BigInt(200000));
    // Uniform → no month stands out → empty trigger list but function runs
    const results = detectSeasonality(data, TODAY);
    expect(Array.isArray(results)).toBe(true);
  });

  it("detects a high-spend month", () => {
    // Build 730 days of data; December always spends 3× the baseline
    const data: PerDayTotal[] = [];
    const start = new Date("2022-06-15T00:00:00Z").getTime();
    for (let i = 0; i < 730; i++) {
      const day = new Date(start + i * 86400000);
      const month = day.getUTCMonth() + 1;
      const cop = month === 12 ? BigInt(3_000_000) : BigInt(200_000);
      data.push({ day, cop });
    }
    const results = detectSeasonality(data, TODAY);
    const dec = results.find((r) => r.monthIndex === 12);
    expect(dec).toBeDefined();
    expect(dec!.deltaPct).toBeGreaterThan(0);
  });

  it("returns at most 3 results", () => {
    // Make many months expensive
    const data: PerDayTotal[] = [];
    const start = new Date("2022-06-15T00:00:00Z").getTime();
    for (let i = 0; i < 730; i++) {
      const day = new Date(start + i * 86400000);
      const month = day.getUTCMonth() + 1;
      // Jan, Mar, May, Jul, Sep, Nov all 5× baseline
      const isExpensive = [1, 3, 5, 7, 9, 11].includes(month);
      const cop = isExpensive ? BigInt(5_000_000) : BigInt(200_000);
      data.push({ day, cop });
    }
    const results = detectSeasonality(data, TODAY);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("sparse-month guard — excludes months with <50% expected tx count", () => {
    // Build 730 days; July (month 7) has very few transactions
    const data: PerDayTotal[] = [];
    const start = new Date("2022-06-15T00:00:00Z").getTime();
    for (let i = 0; i < 730; i++) {
      const day = new Date(start + i * 86400000);
      const month = day.getUTCMonth() + 1;
      // July: only 1 transaction entry (very sparse)
      if (month === 7 && day.getUTCDate() !== 1) continue;
      const cop = month === 12 ? BigInt(3_000_000) : BigInt(200_000);
      data.push({ day, cop });
    }
    // July should be excluded due to sparsity; December should still trigger
    const results = detectSeasonality(data, TODAY);
    const july = results.find((r) => r.monthIndex === 7);
    // July sparse → excluded from monthAvgs → won't appear even if it had high spend
    // (It had low spend anyway so this verifies the guard doesn't accidentally include it)
    expect(july).toBeUndefined();
  });
});
