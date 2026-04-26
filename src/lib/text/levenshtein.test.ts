// Unit tests for levenshtein utilities.
// Pure functions — no DB, no env setup needed. Default Vitest env (node).

import { describe, expect, it } from "vitest";

import { levenshtein, levenshteinRatio } from "./levenshtein";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(levenshtein("HELLO", "hello")).toBe(0);
    expect(levenshtein("Maria Eugenia", "MARIA EUGENIA")).toBe(0);
  });

  it("returns length of the other string for empty input", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });

  it("single character substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("single insertion", () => {
    expect(levenshtein("abc", "abcd")).toBe(1);
  });

  it("single deletion", () => {
    expect(levenshtein("abcd", "abc")).toBe(1);
  });

  it("typical counterparty mismatch — different capitalisation and spacing", () => {
    // "Maria Eugenia" vs "maria eugenia" (ARQ example from issue #517)
    expect(levenshtein("Maria Eugenia", "maria eugenia")).toBe(0);
  });

  it("different strings have positive distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("completely different strings", () => {
    const d = levenshtein("abc", "xyz");
    expect(d).toBeGreaterThan(0);
  });
});

describe("levenshteinRatio", () => {
  it("returns 1 for identical strings", () => {
    expect(levenshteinRatio("hello", "hello")).toBe(1);
  });

  it("returns 1 for case-insensitive identical strings", () => {
    expect(levenshteinRatio("Maria", "MARIA")).toBe(1);
  });

  it("returns 1 for both-empty strings", () => {
    expect(levenshteinRatio("", "")).toBe(1);
  });

  it("returns 0 when one string is empty and the other is not", () => {
    expect(levenshteinRatio("", "abc")).toBe(0);
    expect(levenshteinRatio("abc", "")).toBe(0);
  });

  it("returns ratio in (0, 1) for partial matches", () => {
    const r = levenshteinRatio("Maria Eugenia", "Maria E");
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });

  it("similar counterparty names score ≥ 0.7 (COUNTERPARTY_MATCH_THRESHOLD)", () => {
    // Realistic ARQ example: email uses full name, statement uses trimmed name.
    expect(levenshteinRatio("Maria Eugenia Lopez", "maria eugenia lopez")).toBeGreaterThanOrEqual(
      0.7,
    );
    expect(levenshteinRatio("PEXTO COLOMBIA", "Pexto Colombia")).toBeGreaterThanOrEqual(0.7);
  });

  it("clearly different names score below 0.3 (COUNTERPARTY_DIVERGE_THRESHOLD)", () => {
    // "xyz" vs "abcdefghij" — completely different and the shorter is only 3 chars
    expect(levenshteinRatio("xyz", "abcdefghijkl")).toBeLessThan(0.3);
    // Very different strings with no common prefix/suffix
    expect(levenshteinRatio("qqqq", "wwwwwwwwwwwwwwww")).toBeLessThan(0.3);
  });

  it("ratio is symmetric", () => {
    const a = levenshteinRatio("abc", "abcdef");
    const b = levenshteinRatio("abcdef", "abc");
    expect(a).toBeCloseTo(b, 10);
  });
});
