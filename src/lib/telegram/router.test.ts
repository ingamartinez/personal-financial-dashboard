import { describe, expect, it } from "vitest";
import { parseAmountFromText } from "./router";

describe("parseAmountFromText", () => {
  it("parses '45k' as 45000 pesos (cents = 4500000)", () => {
    expect(parseAmountFromText("45k")).toBe("4500000");
  });

  it("parses '45K' case-insensitive", () => {
    expect(parseAmountFromText("45K")).toBe("4500000");
  });

  it("parses '45 mil' as 45000", () => {
    expect(parseAmountFromText("45 mil")).toBe("4500000");
  });

  it("parses '2 millones' as 2000000", () => {
    expect(parseAmountFromText("2 millones")).toBe("200000000");
  });

  it("parses '2M' as 2000000", () => {
    expect(parseAmountFromText("2M")).toBe("200000000");
  });

  it("parses Colombian thousand separator '123.450'", () => {
    expect(parseAmountFromText("123.450")).toBe("12345000");
  });

  it("parses decimal with comma '12,50'", () => {
    expect(parseAmountFromText("12,50")).toBe("1250");
  });

  it("strips dollar sign", () => {
    expect(parseAmountFromText("$45000")).toBe("4500000");
  });

  it("parses plain integer", () => {
    expect(parseAmountFromText("45000")).toBe("4500000");
  });

  it("returns null for non-numeric input", () => {
    expect(parseAmountFromText("hola")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAmountFromText("")).toBeNull();
  });
});
