import { describe, expect, it } from "vitest";
import { confidenceBand } from "./confidence-badge";

describe("confidenceBand", () => {
  it("returns null for manual and unclassified methods regardless of confidence", () => {
    expect(confidenceBand("manual", 100)).toBeNull();
    expect(confidenceBand("manual", 55)).toBeNull();
    expect(confidenceBand("manual_confirmed", 100)).toBeNull();
    expect(confidenceBand("unclassified", null)).toBeNull();
  });

  it("returns null when confidence is null", () => {
    expect(confidenceBand("rule", null)).toBeNull();
    expect(confidenceBand("ai", null)).toBeNull();
  });

  it("bucketizes rule classifications by confidence thresholds", () => {
    expect(confidenceBand("rule", 100)).toBe("high");
    expect(confidenceBand("rule", 90)).toBe("high");
    expect(confidenceBand("rule", 89)).toBe("medium");
    expect(confidenceBand("rule", 60)).toBe("medium");
    expect(confidenceBand("rule", 59)).toBe("low");
    expect(confidenceBand("rule", 0)).toBe("low");
  });

  it("bucketizes ai classifications identically to rule", () => {
    expect(confidenceBand("ai", 95)).toBe("high");
    expect(confidenceBand("ai", 75)).toBe("medium");
    expect(confidenceBand("ai", 30)).toBe("low");
  });
});
