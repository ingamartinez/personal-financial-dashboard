// #433 — unit tests for the flexible "saldo real" amount parser. Pure
// function, no DOM / no DB.

import { describe, expect, it } from "vitest";

import { parseSignedAmountToCents } from "./parse-saldo-real";

describe("parseSignedAmountToCents (#433)", () => {
  it("returns undefined for an empty field", () => {
    expect(parseSignedAmountToCents("")).toBeUndefined();
    expect(parseSignedAmountToCents("   ")).toBeUndefined();
  });

  it("parses plain integers", () => {
    expect(parseSignedAmountToCents("100")).toBe(BigInt(10000));
    expect(parseSignedAmountToCents("-100")).toBe(BigInt(-10000));
    expect(parseSignedAmountToCents("0")).toBe(BigInt(0));
  });

  it("parses COP-style thousand separators", () => {
    // 1.500.000,00 → 150_000_000 cents
    expect(parseSignedAmountToCents("1.500.000,00")).toBe(BigInt(150_000_000));
    expect(parseSignedAmountToCents("-1.500.000,50")).toBe(BigInt(-150_000_050));
  });

  it("parses US-style thousand separators", () => {
    // 1,500,000.00 → 150_000_000 cents
    expect(parseSignedAmountToCents("1,500,000.00")).toBe(BigInt(150_000_000));
    expect(parseSignedAmountToCents("-1,500,000.50")).toBe(BigInt(-150_000_050));
  });

  it("parses plain decimals with . or , as decimal separator", () => {
    expect(parseSignedAmountToCents("1500000.50")).toBe(BigInt(150_000_050));
    expect(parseSignedAmountToCents("1500000,50")).toBe(BigInt(150_000_050));
    expect(parseSignedAmountToCents("-1500000.5")).toBe(BigInt(-150_000_050));
  });

  it("treats ambiguous 3-digit fractions as thousand separators", () => {
    // "1.234" is usually "1234", not "1.234"
    expect(parseSignedAmountToCents("1.234")).toBe(BigInt(123_400));
    expect(parseSignedAmountToCents("1,234")).toBe(BigInt(123_400));
  });

  it("strips currency symbols + whitespace", () => {
    expect(parseSignedAmountToCents("$ 1.500,00")).toBe(BigInt(150_000));
    expect(parseSignedAmountToCents("- $1,500.00 ")).toBe(BigInt(-150_000));
  });

  it("returns null for non-numeric garbage", () => {
    expect(parseSignedAmountToCents("abc")).toBeNull();
    expect(parseSignedAmountToCents("1.5.00a")).toBeNull();
    expect(parseSignedAmountToCents("--5")).toBeNull();
  });

  it("handles 1-digit fractional part by padding", () => {
    expect(parseSignedAmountToCents("1.5")).toBe(BigInt(150));
    expect(parseSignedAmountToCents("100,5")).toBe(BigInt(10050));
  });
});
