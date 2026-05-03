import { describe, expect, it } from "vitest";
import { safeLimitCents } from "./limit";

describe("safeLimitCents", () => {
  it("returns BigInt for a valid positive integer", () => {
    expect(safeLimitCents(10_000_000)).toBe(BigInt(10_000_000));
  });

  it("returns BigInt(1) for the minimum valid integer", () => {
    expect(safeLimitCents(1)).toBe(BigInt(1));
  });

  it("returns null for 0", () => {
    expect(safeLimitCents(0)).toBeNull();
  });

  it("returns null for a negative integer", () => {
    expect(safeLimitCents(-500)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(safeLimitCents(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(safeLimitCents(null)).toBeNull();
  });

  it("returns null for a non-integer float (999.99)", () => {
    expect(safeLimitCents(999.99)).toBeNull();
  });

  it("returns null for a string (runtime guard)", () => {
    // TS would normally block this, but JSONB can deliver any value at runtime.
    expect(safeLimitCents("50000" as unknown as number)).toBeNull();
  });

  it("returns BigInt for Number.MAX_SAFE_INTEGER", () => {
    expect(safeLimitCents(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });
});
