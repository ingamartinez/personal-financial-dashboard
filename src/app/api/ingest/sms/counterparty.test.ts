import { describe, expect, it } from "vitest";
import { normalizeName } from "./route";

describe("normalizeName", () => {
  it("uppercases and trims simple names", () => {
    expect(normalizeName("juan perez")).toBe("JUAN PEREZ");
    expect(normalizeName("  maria paz  ")).toBe("MARIA PAZ");
  });

  it("collapses internal whitespace so Bancolombia variations resolve to same alias", () => {
    expect(normalizeName("DILAN  DEJANON")).toBe("DILAN DEJANON");
    expect(normalizeName("DILAN\tDEJANON")).toBe("DILAN DEJANON");
    expect(normalizeName("DILAN\n DEJANON")).toBe("DILAN DEJANON");
  });

  it("is idempotent", () => {
    const v = normalizeName("  Dilan  dEjAnON  ");
    expect(v).toBe("DILAN DEJANON");
    expect(normalizeName(v)).toBe(v);
  });

  it("preserves accented chars (they uppercase consistently)", () => {
    expect(normalizeName("José López")).toBe("JOSÉ LÓPEZ");
  });
});
