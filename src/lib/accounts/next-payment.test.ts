import { describe, expect, it } from "vitest";
import { computeNextPayment } from "./next-payment";

describe("computeNextPayment", () => {
  it("returns null for invalid cutoff inputs", () => {
    const today = new Date("2026-04-20T12:00:00Z");
    expect(computeNextPayment(null, today)).toBeNull();
    expect(computeNextPayment(undefined, today)).toBeNull();
    expect(computeNextPayment(0, today)).toBeNull();
    expect(computeNextPayment(32, today)).toBeNull();
    expect(computeNextPayment(1.5, today)).toBeNull();
    expect(computeNextPayment(NaN, today)).toBeNull();
  });

  it("returns this cycle's payment when today is before the cycle cutoff+15", () => {
    // cutoff=5, today=2026-04-01 → this cycle: cutoff 2026-04-05 → payment 2026-04-20.
    const today = new Date("2026-04-01T12:00:00Z");
    expect(computeNextPayment(5, today)).toBe("2026-04-20");
  });

  it("returns this cycle's payment when today equals the payment date", () => {
    const today = new Date("2026-04-20T12:00:00Z");
    expect(computeNextPayment(5, today)).toBe("2026-04-20");
  });

  it("rolls to next cycle when today is past this cycle's payment date", () => {
    // cutoff=5, today=2026-04-21 → this cycle's payment (2026-04-20) has passed →
    // next cycle: cutoff 2026-05-05 → payment 2026-05-20.
    const today = new Date("2026-04-21T12:00:00Z");
    expect(computeNextPayment(5, today)).toBe("2026-05-20");
  });

  it("clamps cutoff=31 to the last day of a short month (Feb 2026, 28d)", () => {
    // cutoff=31, today=2026-02-01 → this cycle: cutoff clamped to 2026-02-28 →
    // payment 2026-03-15.
    const today = new Date("2026-02-01T12:00:00Z");
    expect(computeNextPayment(31, today)).toBe("2026-03-15");
  });

  it("handles year rollover (December cutoff past → next cycle in January)", () => {
    // cutoff=10, today=2026-12-26 → this cycle's payment was 2026-12-25 (past)
    // → next cycle cutoff 2027-01-10 → payment 2027-01-25.
    const today = new Date("2026-12-26T12:00:00Z");
    expect(computeNextPayment(10, today)).toBe("2027-01-25");
  });
});
