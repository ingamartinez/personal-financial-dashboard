/**
 * Unit tests for merchant-anomaly.ts pure functions.
 * No DB, no side-effects — all test-doubles are in-memory.
 *
 * NOTE: BigInt literals (0n) are ES2020+. This project targets ES2017, so we
 * use BigInt() constructor calls throughout (matching the tc-health.test.ts pattern).
 */

import { describe, expect, it } from "vitest";
import {
  ANOMALY_FACTOR_THRESHOLD,
  ANOMALY_MIN_DELTA_CENTS,
  ANOMALY_MIN_HISTORY,
  detectFirstEncounter,
  detectMerchantAnomaly,
  evaluateMerchantSignals,
} from "./merchant-anomaly";

// ---------------------------------------------------------------------------
// detectMerchantAnomaly
// ---------------------------------------------------------------------------

describe("detectMerchantAnomaly — threshold rules", () => {
  it("returns isAnomaly=false when history has fewer than 5 entries", () => {
    // 4 < ANOMALY_MIN_HISTORY(5)
    const history = {
      amounts: [BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000)],
    };
    expect(detectMerchantAnomaly(BigInt(50_000), history)).toEqual({ isAnomaly: false });
  });

  it("returns isAnomaly=false when exactly 5 entries but amount < 3× avg", () => {
    // avg = 10_000, tx = 20_000 (2× avg — below 3×)
    const history = {
      amounts: [BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000)],
    };
    expect(detectMerchantAnomaly(BigInt(20_000), history)).toEqual({ isAnomaly: false });
  });

  it("returns isAnomaly=false when factor >= 3 but delta < 10 000", () => {
    // avg = 2 000, tx = 7 000 (3.5× avg), but delta = 5 000 < 10_000
    const history = {
      amounts: [BigInt(2_000), BigInt(2_000), BigInt(2_000), BigInt(2_000), BigInt(2_000)],
    };
    const result = detectMerchantAnomaly(BigInt(7_000), history);
    expect(result.isAnomaly).toBe(false);
  });

  it("fires when amount is exactly 3× avg AND delta >= 10 000", () => {
    // avg = 10 000, tx = 30 000 (exactly 3×), delta = 20 000 >= 10 000
    const history = {
      amounts: [BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000)],
    };
    const result = detectMerchantAnomaly(BigInt(30_000), history);
    expect(result.isAnomaly).toBe(true);
    if (!result.isAnomaly) return; // type narrowing
    expect(result.factor).toBeCloseTo(3.0, 5);
    expect(result.deltaCents).toBe(BigInt(20_000));
    expect(result.baselineAvgCents).toBe(BigInt(10_000));
  });

  it("fires when amount is >3× avg (e.g. 4×) with sufficient delta", () => {
    // avg = 10 000, tx = 40 000 (4×), delta = 30 000
    const history = {
      amounts: [BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000)],
    };
    const result = detectMerchantAnomaly(BigInt(40_000), history);
    expect(result.isAnomaly).toBe(true);
    if (!result.isAnomaly) return;
    expect(result.factor).toBeCloseTo(4.0, 5);
    expect(result.deltaCents).toBe(BigInt(30_000));
  });

  it("fires with minimum viable scenario: 5 entries, 3× factor, delta >= 10k", () => {
    // avg = 15_000, tx = 45_000 (3×), delta = 30_000
    const history = {
      amounts: [BigInt(15_000), BigInt(15_000), BigInt(15_000), BigInt(15_000), BigInt(15_000)],
    };
    const result = detectMerchantAnomaly(BigInt(45_000), history);
    expect(result.isAnomaly).toBe(true);
  });

  it("uses rolling average correctly across varied amounts", () => {
    // amounts: [5k, 10k, 15k, 10k, 10k] → avg = 10k
    // tx = 32k (3.2×), delta = 22k → should fire
    const history = {
      amounts: [BigInt(5_000), BigInt(10_000), BigInt(15_000), BigInt(10_000), BigInt(10_000)],
    };
    const result = detectMerchantAnomaly(BigInt(32_000), history);
    expect(result.isAnomaly).toBe(true);
    if (!result.isAnomaly) return;
    expect(result.baselineAvgCents).toBe(BigInt(10_000));
  });

  it("returns isAnomaly=false when avg is 0", () => {
    // Edge case: all-zero history (should never happen in practice)
    const history = {
      amounts: [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)],
    };
    expect(detectMerchantAnomaly(BigInt(0), history)).toEqual({ isAnomaly: false });
  });

  it("handles BigInt math correctly for large amounts (COP scale)", () => {
    // 6 transactions at $500k COP average; new tx at $1.6M (3.2×), delta = 1.1M
    const avg = BigInt(500_000);
    const history = {
      amounts: [avg, avg, avg, avg, avg, avg],
    };
    const txAmount = BigInt(1_600_000);
    const result = detectMerchantAnomaly(txAmount, history);
    expect(result.isAnomaly).toBe(true);
    if (!result.isAnomaly) return;
    expect(result.baselineAvgCents).toBe(avg);
    expect(result.deltaCents).toBe(txAmount - avg);
  });

  it("exactly meets ANOMALY_MIN_DELTA_CENTS boundary (10 000) — fires", () => {
    // avg = 1 000, tx = 11 000 (11×), delta = 10 000 exactly
    const history = {
      amounts: [BigInt(1_000), BigInt(1_000), BigInt(1_000), BigInt(1_000), BigInt(1_000)],
    };
    const result = detectMerchantAnomaly(BigInt(11_000), history);
    expect(result.isAnomaly).toBe(true);
    if (!result.isAnomaly) return;
    expect(result.deltaCents).toBe(ANOMALY_MIN_DELTA_CENTS);
  });

  it("one below ANOMALY_MIN_DELTA_CENTS boundary (9 999) — does NOT fire", () => {
    // avg = 1 000, tx = 10_999 (~11×), delta = 9_999 < 10_000
    const history = {
      amounts: [BigInt(1_000), BigInt(1_000), BigInt(1_000), BigInt(1_000), BigInt(1_000)],
    };
    const result = detectMerchantAnomaly(BigInt(10_999), history);
    expect(result.isAnomaly).toBe(false);
  });

  it("boundary at exactly ANOMALY_MIN_HISTORY entries — fires when thresholds met", () => {
    const count = ANOMALY_MIN_HISTORY;
    const history = { amounts: Array(count).fill(BigInt(10_000)) as bigint[] };
    const result = detectMerchantAnomaly(BigInt(30_001), history); // 3× + delta > 10k
    expect(result.isAnomaly).toBe(true);
  });

  it("one below ANOMALY_FACTOR_THRESHOLD boundary — does NOT fire", () => {
    // threshold is 3×; test with 299_999 < 3 * 100_000 (300_000)
    const history = {
      amounts: [
        BigInt(100_000),
        BigInt(100_000),
        BigInt(100_000),
        BigInt(100_000),
        BigInt(100_000),
      ],
    };
    const result = detectMerchantAnomaly(BigInt(299_999), history);
    // 299_999 < 3 * 100_000 → below threshold
    expect(result.isAnomaly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectFirstEncounter
// ---------------------------------------------------------------------------

describe("detectFirstEncounter", () => {
  it("returns true when historyCount is 0", () => {
    expect(detectFirstEncounter(0)).toBe(true);
  });

  it("returns false when historyCount is 1", () => {
    expect(detectFirstEncounter(1)).toBe(false);
  });

  it("returns false when historyCount is 100", () => {
    expect(detectFirstEncounter(100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateMerchantSignals — combined logic and skip rules
// ---------------------------------------------------------------------------

describe("evaluateMerchantSignals — first-encounter takes priority", () => {
  it("returns first_encounter when fullHistoryCount=0 even if amounts would be anomalous", () => {
    // fullHistoryCount=0 means first-ever tx — anomaly is irrelevant
    const result = evaluateMerchantSignals(
      BigInt(1_000_000),
      0, // no prior history
      { amounts: [] }, // windowHistory is irrelevant but we pass empty
    );
    expect(result.signal).toBe("first_encounter");
  });

  it("does NOT return first_encounter when fullHistoryCount=1", () => {
    const result = evaluateMerchantSignals(BigInt(30_000), 1, { amounts: [] });
    // history < 5, so anomaly doesn't fire either → none
    expect(result.signal).toBe("none");
  });
});

describe("evaluateMerchantSignals — B.1 anomaly fires after first-encounter window passes", () => {
  it("returns anomaly when fullHistoryCount >= 1 and thresholds met", () => {
    const result = evaluateMerchantSignals(
      BigInt(30_000),
      10, // prior history exists
      {
        amounts: [BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000)],
      },
    );
    expect(result.signal).toBe("anomaly");
    if (result.signal !== "anomaly") return;
    expect(result.factor).toBeCloseTo(3.0, 5);
    expect(result.deltaCents).toBe(BigInt(20_000));
    expect(result.baselineAvgCents).toBe(BigInt(10_000));
  });

  it("returns none when fullHistoryCount >= 1 but window history < 5", () => {
    const result = evaluateMerchantSignals(
      BigInt(30_000),
      10,
      { amounts: [BigInt(10_000), BigInt(10_000), BigInt(10_000)] }, // only 3 entries
    );
    expect(result.signal).toBe("none");
  });

  it("returns none when fullHistoryCount >= 1 and window history >= 5 but no anomaly", () => {
    // Normal amount — 1× avg, no anomaly
    const result = evaluateMerchantSignals(BigInt(10_000), 5, {
      amounts: [BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000), BigInt(10_000)],
    });
    expect(result.signal).toBe("none");
  });
});

describe("evaluateMerchantSignals — currency split is caller responsibility", () => {
  it("handles large COP amounts correctly with BigInt math", () => {
    // Simulates a $5M COP purchase where avg is $1M
    const result = evaluateMerchantSignals(BigInt(5_000_000), 20, {
      amounts: [
        BigInt(1_000_000),
        BigInt(1_000_000),
        BigInt(1_000_000),
        BigInt(1_000_000),
        BigInt(1_000_000),
      ],
    });
    expect(result.signal).toBe("anomaly");
    if (result.signal !== "anomaly") return;
    expect(result.factor).toBeCloseTo(5.0, 5);
    expect(result.deltaCents).toBe(BigInt(4_000_000));
  });
});

describe("evaluateMerchantSignals — constants", () => {
  it("ANOMALY_FACTOR_THRESHOLD is BigInt(3)", () => {
    expect(ANOMALY_FACTOR_THRESHOLD).toBe(BigInt(3));
  });

  it("ANOMALY_MIN_DELTA_CENTS is BigInt(10_000)", () => {
    expect(ANOMALY_MIN_DELTA_CENTS).toBe(BigInt(10_000));
  });

  it("ANOMALY_MIN_HISTORY is 5", () => {
    expect(ANOMALY_MIN_HISTORY).toBe(5);
  });
});
