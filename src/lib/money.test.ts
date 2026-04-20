import { describe, expect, it } from "vitest";
import {
  convertCents,
  decimalStringToCents,
  displayCurrencyFor,
  parseTolerantMoney,
  toCop,
} from "./money";

describe("decimalStringToCents", () => {
  it("parses single-digit cent values", () => {
    expect(decimalStringToCents("0.01")).toBe(BigInt(1));
    expect(decimalStringToCents("0.1")).toBe(BigInt(10));
    expect(decimalStringToCents("0.10")).toBe(BigInt(10));
  });

  it("parses whole amounts without losing trailing zeros in cents", () => {
    expect(decimalStringToCents("100")).toBe(BigInt(10000));
    expect(decimalStringToCents("100.00")).toBe(BigInt(10000));
    expect(decimalStringToCents("0")).toBe(BigInt(0));
  });

  it("handles values where float math silently loses precision", () => {
    // `1000.99 * 100` is 100099.00000000001 in IEEE-754; integer arithmetic
    // keeps exact cents.
    expect(decimalStringToCents("1000.99")).toBe(BigInt(100099));
    expect(decimalStringToCents("100.99")).toBe(BigInt(10099));
  });

  it("handles large amounts near the typical form ceiling", () => {
    expect(decimalStringToCents("9999999.99")).toBe(BigInt(999999999));
  });

  it("rejects non-numeric input", () => {
    expect(() => decimalStringToCents("abc")).toThrow(/Invalid decimal/);
    expect(() => decimalStringToCents("")).toThrow(/Invalid decimal/);
    expect(() => decimalStringToCents(" 100 ")).toThrow(/Invalid decimal/);
  });

  it("rejects more than 2 decimal places", () => {
    expect(() => decimalStringToCents("1.234")).toThrow(/Invalid decimal/);
    expect(() => decimalStringToCents("9.995")).toThrow(/Invalid decimal/);
  });

  it("rejects negative numbers", () => {
    expect(() => decimalStringToCents("-5")).toThrow(/Invalid decimal/);
    expect(() => decimalStringToCents("-0.01")).toThrow(/Invalid decimal/);
  });

  it("rejects thousand separators and scientific notation", () => {
    expect(() => decimalStringToCents("1,000")).toThrow(/Invalid decimal/);
    expect(() => decimalStringToCents("1e5")).toThrow(/Invalid decimal/);
  });
});

describe("parseTolerantMoney", () => {
  it("parses plain integers", () => {
    expect(parseTolerantMoney("1234567")).toBe(BigInt(123456700));
    expect(parseTolerantMoney("0")).toBe(BigInt(0));
  });

  it("parses es-CO grouping ('.' thousand, ',' decimal)", () => {
    expect(parseTolerantMoney("1.234.567,89")).toBe(BigInt(123456789));
    expect(parseTolerantMoney("1.234.567")).toBe(BigInt(123456700));
  });

  it("parses en-US grouping (',' thousand, '.' decimal)", () => {
    expect(parseTolerantMoney("1,234,567.89")).toBe(BigInt(123456789));
    expect(parseTolerantMoney("1,234.56")).toBe(BigInt(123456));
  });

  it("handles negatives (credit card balances)", () => {
    expect(parseTolerantMoney("-4.500.000")).toBe(BigInt(-450000000));
    expect(parseTolerantMoney("-1234.56")).toBe(BigInt(-123456));
  });

  it("strips whitespace and currency symbols", () => {
    expect(parseTolerantMoney("  $ 1.000 ")).toBe(BigInt(100000));
    expect(parseTolerantMoney("$1,000.50")).toBe(BigInt(100050));
  });

  it("accepts single-cent decimals", () => {
    expect(parseTolerantMoney("100,5")).toBe(BigInt(10050));
    expect(parseTolerantMoney("100.5")).toBe(BigInt(10050));
  });

  it("rejects garbage input", () => {
    expect(() => parseTolerantMoney("abc")).toThrow(/Invalid money/);
    expect(() => parseTolerantMoney("")).toThrow(/Empty money/);
    expect(() => parseTolerantMoney("1e5")).toThrow(/Invalid money/);
  });
});

describe("displayCurrencyFor", () => {
  it("returns source currency in native mode", () => {
    expect(displayCurrencyFor("native", "COP")).toBe("COP");
    expect(displayCurrencyFor("native", "USD")).toBe("USD");
  });

  it("forces target currency in all-cop / all-usd modes", () => {
    expect(displayCurrencyFor("all-cop", "COP")).toBe("COP");
    expect(displayCurrencyFor("all-cop", "USD")).toBe("COP");
    expect(displayCurrencyFor("all-usd", "COP")).toBe("USD");
    expect(displayCurrencyFor("all-usd", "USD")).toBe("USD");
  });
});

describe("convertCents", () => {
  it("returns input unchanged when currencies match", () => {
    expect(convertCents(BigInt(12345), "USD", "USD", 4000)).toBe(BigInt(12345));
    expect(convertCents(BigInt(12345), "COP", "COP", 4000)).toBe(BigInt(12345));
  });

  it("USD -> COP matches toCop semantics (100 USD_cents @ 4000 = 400_000 COP_cents)", () => {
    expect(convertCents(BigInt(100), "USD", "COP", 4000)).toBe(BigInt(400_000));
    expect(convertCents(BigInt(100), "USD", "COP", 4000)).toBe(toCop(BigInt(100), "USD", 4000));
  });

  it("COP -> USD is the inverse of USD -> COP", () => {
    expect(convertCents(BigInt(400_000), "COP", "USD", 4000)).toBe(BigInt(100));
  });

  it("roundtrips USD -> COP -> USD within integer rounding", () => {
    const startUsdCents = BigInt(1234);
    const cop = convertCents(startUsdCents, "USD", "COP", 3990);
    const back = convertCents(cop, "COP", "USD", 3990);
    expect(back).toBe(startUsdCents);
  });

  it("uses micros precision for non-round rates", () => {
    expect(convertCents(BigInt(100), "USD", "COP", 3990.5)).toBe(BigInt(399_050));
  });
});
