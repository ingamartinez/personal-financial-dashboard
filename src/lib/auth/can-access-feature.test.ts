import { describe, expect, it } from "vitest";
import { canAccessFeature, type PremiumFeature } from "./can-access-feature";

describe("canAccessFeature — v1 always returns true", () => {
  const features: PremiumFeature[] = [
    "cdt-suggestion",
    "fic-suggestion",
    "monthly-claude-report",
    "conversational-insights",
  ];

  for (const feature of features) {
    it(`returns true for feature "${feature}"`, async () => {
      const result = await canAccessFeature(1, feature);
      expect(result).toBe(true);
    });
  }

  it("returns true for any userId (stub is user-agnostic)", async () => {
    expect(await canAccessFeature(0, "cdt-suggestion")).toBe(true);
    expect(await canAccessFeature(999, "fic-suggestion")).toBe(true);
  });
});
