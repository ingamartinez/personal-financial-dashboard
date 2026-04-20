import { describe, expect, it } from "vitest";
import { formatAccountLabel } from "./format";

describe("formatAccountLabel", () => {
  const base = {
    name: "Bancolombia Mastercard *7291",
    currency: "COP",
    institution: "Bancolombia",
  };

  it("default: appends currency in parens", () => {
    expect(formatAccountLabel(base)).toBe("Bancolombia Mastercard *7291 (COP)");
  });

  it("disambiguates same-name multi-currency accounts via currency", () => {
    const cop = formatAccountLabel({ ...base, currency: "COP" });
    const usd = formatAccountLabel({ ...base, currency: "USD" });
    expect(cop).not.toBe(usd);
    expect(cop).toBe("Bancolombia Mastercard *7291 (COP)");
    expect(usd).toBe("Bancolombia Mastercard *7291 (USD)");
  });

  it("withInstitution: prepends institution + bullet", () => {
    expect(formatAccountLabel(base, { withInstitution: true })).toBe(
      "Bancolombia · Bancolombia Mastercard *7291 (COP)",
    );
  });

  it("withInstitution: skips prefix when institution missing", () => {
    expect(formatAccountLabel({ ...base, institution: null }, { withInstitution: true })).toBe(
      "Bancolombia Mastercard *7291 (COP)",
    );
  });

  it("withLast4: appends *last4 from metadata when not already in name", () => {
    expect(
      formatAccountLabel(
        { name: "Visa Internacional", currency: "USD", metadata: { last4s: ["4321"] } },
        { withLast4: true },
      ),
    ).toBe("Visa Internacional *4321 (USD)");
  });

  it("withLast4: skips append when name already contains *last4", () => {
    // Real-world case: Telegram keyboard avoids "Visa *7291 *7291"
    expect(
      formatAccountLabel({ ...base, metadata: { last4s: ["7291"] } }, { withLast4: true }),
    ).toBe("Bancolombia Mastercard *7291 (COP)");
  });

  it("withLast4: no-op when metadata has no last4s", () => {
    expect(
      formatAccountLabel(
        { name: "Cash", currency: "COP", metadata: { last4s: [] } },
        { withLast4: true },
      ),
    ).toBe("Cash (COP)");
  });

  it("withLast4: no-op when metadata is null", () => {
    expect(formatAccountLabel({ name: "Cash", currency: "COP" }, { withLast4: true })).toBe(
      "Cash (COP)",
    );
  });

  it("withLast4: accepts top-level last4s shape (NluAccountOption)", () => {
    expect(
      formatAccountLabel(
        { name: "Visa Internacional", currency: "USD", last4s: ["4321"] },
        { withLast4: true },
      ),
    ).toBe("Visa Internacional *4321 (USD)");
  });

  it("combines withInstitution + withLast4", () => {
    expect(
      formatAccountLabel(
        {
          name: "Visa Internacional",
          currency: "USD",
          institution: "Bancolombia",
          metadata: { last4s: ["4321"] },
        },
        { withInstitution: true, withLast4: true },
      ),
    ).toBe("Bancolombia · Visa Internacional *4321 (USD)");
  });
});
