import { describe, expect, it } from "vitest";
import {
  evaluateCategoryAnomaly,
  CATEGORY_ANOMALY_MIN_HISTORY,
  CATEGORY_ANOMALY_MIN_SHARE,
  type CategoryHistoryEntry,
} from "./category-anomaly-detector";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function historyOf(entries: Array<[string, number]>): CategoryHistoryEntry[] {
  return entries.map(([categorySlug, count]) => ({ categorySlug, count }));
}

// ---------------------------------------------------------------------------
// Tests — evaluateCategoryAnomaly (pure)
// ---------------------------------------------------------------------------

describe("evaluateCategoryAnomaly — skip when insufficient history", () => {
  it("returns isAnomaly=false when total < 10", () => {
    // 9 prior txs — below threshold
    const history = historyOf([["__catanom_test_alimentacion", 9]]);
    const result = evaluateCategoryAnomaly(history, "__catanom_test_transporte");
    expect(result.isAnomaly).toBe(false);
  });

  it("returns isAnomaly=false when history is empty", () => {
    const result = evaluateCategoryAnomaly([], "__catanom_test_transporte");
    expect(result.isAnomaly).toBe(false);
  });

  it("fires at exactly 10 prior txs (boundary)", () => {
    // 10 txs, 9 in modal category → share = 0.9 ≥ 0.8 → anomaly
    const history = historyOf([
      ["__catanom_test_alimentacion", 9],
      ["__catanom_test_transporte", 1],
    ]);
    const result = evaluateCategoryAnomaly(history, "__catanom_test_transporte");
    // actual = transporte (1/10 = 10%) vs expected = alimentacion (9/10 = 90%)
    expect(result.isAnomaly).toBe(true);
  });
});

describe("evaluateCategoryAnomaly — modal share threshold", () => {
  it("fires when modal share is exactly 80% (boundary)", () => {
    // 8 alimentacion + 2 transporte → alimentacion is modal at exactly 0.80
    const history = historyOf([
      ["__catanom_test_alimentacion", 8],
      ["__catanom_test_transporte", 2],
    ]);
    const result = evaluateCategoryAnomaly(history, "__catanom_test_transporte");
    expect(result.isAnomaly).toBe(true);
    if (result.isAnomaly) {
      expect(result.modalShare).toBeCloseTo(0.8, 5);
      expect(result.expectedCategory).toBe("__catanom_test_alimentacion");
      expect(result.actualCategory).toBe("__catanom_test_transporte");
    }
  });

  it("does NOT fire when modal share is below 80%", () => {
    // 7 alimentacion + 3 transporte → share = 0.7 < 0.8
    const history = historyOf([
      ["__catanom_test_alimentacion", 7],
      ["__catanom_test_transporte", 3],
    ]);
    const result = evaluateCategoryAnomaly(history, "__catanom_test_transporte");
    expect(result.isAnomaly).toBe(false);
  });

  it("does NOT fire when actual category matches the modal category", () => {
    // 9 alimentacion + 1 transporte → modal = alimentacion at 90%
    // but actual = alimentacion → expected === actual → no anomaly
    const history = historyOf([
      ["__catanom_test_alimentacion", 9],
      ["__catanom_test_transporte", 1],
    ]);
    const result = evaluateCategoryAnomaly(history, "__catanom_test_alimentacion");
    expect(result.isAnomaly).toBe(false);
  });
});

describe("evaluateCategoryAnomaly — high confidence anomalies", () => {
  it("fires when modal share is 100% (all prior in same category)", () => {
    const history = historyOf([["__catanom_test_servicios", 15]]);
    const result = evaluateCategoryAnomaly(history, "__catanom_test_entretenimiento");
    expect(result.isAnomaly).toBe(true);
    if (result.isAnomaly) {
      expect(result.modalShare).toBeCloseTo(1.0, 5);
      expect(result.expectedCategory).toBe("__catanom_test_servicios");
      expect(result.actualCategory).toBe("__catanom_test_entretenimiento");
    }
  });

  it("picks the category with the highest count as the modal", () => {
    // Two categories close in count but one clearly dominant
    const history = historyOf([
      ["__catanom_test_cat_a", 3],
      ["__catanom_test_cat_b", 9],
      ["__catanom_test_cat_c", 1],
      ["__catanom_test_cat_d", 1],
      ["__catanom_test_cat_e", 1],
    ]);
    // total=15, cat_b is modal at 9/15 = 60% — below threshold
    const result = evaluateCategoryAnomaly(history, "__catanom_test_cat_a");
    expect(result.isAnomaly).toBe(false);
  });

  it("fires with multi-category history when modal is dominant", () => {
    const history = historyOf([
      ["__catanom_test_cat_dominant", 12],
      ["__catanom_test_cat_other_1", 1],
      ["__catanom_test_cat_other_2", 1],
      ["__catanom_test_cat_other_3", 1],
    ]);
    // total=15, dominant = 12/15 = 80% → at threshold
    const result = evaluateCategoryAnomaly(history, "__catanom_test_cat_other_1");
    expect(result.isAnomaly).toBe(true);
    if (result.isAnomaly) {
      expect(result.expectedCategory).toBe("__catanom_test_cat_dominant");
    }
  });
});

describe("evaluateCategoryAnomaly — exported constants match spec", () => {
  it("CATEGORY_ANOMALY_MIN_HISTORY is 10", () => {
    expect(CATEGORY_ANOMALY_MIN_HISTORY).toBe(10);
  });
  it("CATEGORY_ANOMALY_MIN_SHARE is 0.8", () => {
    expect(CATEGORY_ANOMALY_MIN_SHARE).toBeCloseTo(0.8);
  });
});
