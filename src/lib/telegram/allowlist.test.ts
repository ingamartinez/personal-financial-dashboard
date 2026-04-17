import { describe, expect, it } from "vitest";
import { isAllowed, parseAllowlist } from "./allowlist";

describe("parseAllowlist", () => {
  it("parses a comma-separated list", () => {
    const set = parseAllowlist("123,456,789");
    expect(set).toEqual(new Set([123, 456, 789]));
  });

  it("trims whitespace", () => {
    const set = parseAllowlist(" 100 , 200 , 300 ");
    expect(set).toEqual(new Set([100, 200, 300]));
  });

  it("returns empty set for undefined", () => {
    expect(parseAllowlist(undefined).size).toBe(0);
  });

  it("returns empty set for empty string", () => {
    expect(parseAllowlist("").size).toBe(0);
  });

  it("skips non-integer values", () => {
    expect(parseAllowlist("123,abc,456")).toEqual(new Set([123, 456]));
  });

  it("rejects negative and zero", () => {
    expect(parseAllowlist("123,0,-1,456")).toEqual(new Set([123, 456]));
  });
});

describe("isAllowed", () => {
  const allowlist = new Set([100, 200]);

  it("accepts allowlisted ids", () => {
    expect(isAllowed(100, allowlist)).toBe(true);
    expect(isAllowed(200, allowlist)).toBe(true);
  });

  it("rejects non-allowlisted ids", () => {
    expect(isAllowed(999, allowlist)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isAllowed(undefined, allowlist)).toBe(false);
  });
});
