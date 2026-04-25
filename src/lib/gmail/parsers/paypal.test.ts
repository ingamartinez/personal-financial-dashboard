import { describe, expect, it } from "vitest";
import { paypalParser } from "./paypal";

// PayPal parser is a stub — no prod samples available yet.
// Tests confirm the stub contract: all inputs return needs_review.

describe("paypalParser — stub", () => {
  it("returns needs_review for any non-empty HTML", () => {
    const html = `<!DOCTYPE html>
<html><body>
<p>PayPal receipt</p>
<p>Amount: $100.00</p>
</body></html>`;
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("paypal_parser_not_implemented");
  });

  it("returns needs_review for empty HTML", () => {
    const r = paypalParser.parse("", {});
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("paypal_parser_not_implemented");
  });
});
