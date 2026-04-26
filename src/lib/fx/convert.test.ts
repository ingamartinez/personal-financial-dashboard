import { describe, it, expect } from "vitest";
import { convertToDisplayCurrency } from "./convert";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTx(
  amountCents: bigint,
  currency: string,
  fx?: {
    originalCurrency: string;
    originalAmountCents: string;
    trmToAccountCurrency: number | null;
    trmSource: string;
    copAmountCents?: string;
  },
) {
  return {
    amountCents,
    currency,
    rawData: fx ? { fx } : null,
  };
}

// ---------------------------------------------------------------------------
// Same-currency tests (no conversion expected)
// ---------------------------------------------------------------------------

describe("convertToDisplayCurrency — same currency", () => {
  it("COP tx in all-cop mode → no conversion", () => {
    const result = convertToDisplayCurrency(
      makeTx(BigInt(-50000), "COP", {
        originalCurrency: "COP",
        originalAmountCents: "50000",
        trmToAccountCurrency: null,
        trmSource: "1_to_1",
      }),
      "all-cop",
    );
    expect(result.converted).toBe(false);
    expect(result.cents).toBe(BigInt(-50000));
    expect(result.currency).toBe("COP");
    expect(result.appliedTrm).toBeNull();
  });

  it("USD tx in all-usd mode → no conversion", () => {
    const result = convertToDisplayCurrency(
      makeTx(BigInt(-135984), "USD", {
        originalCurrency: "USD",
        originalAmountCents: "135984",
        trmToAccountCurrency: 3676.92,
        trmSource: "email_implied",
      }),
      "all-usd",
    );
    expect(result.converted).toBe(false);
    expect(result.cents).toBe(BigInt(-135984));
    expect(result.currency).toBe("USD");
  });

  it("native mode → always no conversion", () => {
    const result = convertToDisplayCurrency(
      makeTx(BigInt(-100000), "USD", {
        originalCurrency: "USD",
        originalAmountCents: "100000",
        trmToAccountCurrency: 4000,
        trmSource: "email_implied",
      }),
      "native",
    );
    expect(result.converted).toBe(false);
    expect(result.cents).toBe(BigInt(-100000));
    expect(result.currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Cross-currency conversion with frozen TRM
// ---------------------------------------------------------------------------

describe("convertToDisplayCurrency — frozen TRM", () => {
  it("USD tx with historical TRM 3676.92 → COP using that TRM (not live rate)", () => {
    // Real example: Mar 14 Venta USDc 1359.84 / 5,000,000 COP.
    // TRM = 5_000_000 / 1_359.84 = 3676.92
    // In cents: 135984 USDc-cents × 3676.92 = expected ~499,949,000 COP-cents.
    const amountCents = BigInt(-135984); // 1359.84 USD
    const trm = 3676.92;
    const result = convertToDisplayCurrency(
      makeTx(amountCents, "USD", {
        originalCurrency: "USD",
        originalAmountCents: "135984",
        trmToAccountCurrency: trm,
        trmSource: "email_implied",
        copAmountCents: "500000000",
      }),
      "all-cop",
    );
    expect(result.converted).toBe(true);
    expect(result.currency).toBe("COP");
    expect(result.appliedTrm).toBe(trm);
    // Expected COP cents: 135984 * 3676.92 ≈ 499,945,893 (integer arithmetic)
    // Must be negative (expense).
    expect(result.cents < BigInt(0)).toBe(true);
    // Rough range check: within 0.01% of 500,000,000 COP-cents.
    const abs = result.cents < BigInt(0) ? -result.cents : result.cents;
    expect(abs).toBeGreaterThan(BigInt(499_000_000));
    expect(abs).toBeLessThan(BigInt(501_000_000));
  });

  it("COP tx with historical TRM → USD", () => {
    // 5,000,000 COP at TRM=3676.92 → ~1359.84 USD → ~135984 USD cents
    const amountCents = BigInt(500000000); // 5,000,000 COP-cents
    const trm = 3676.92;
    const result = convertToDisplayCurrency(
      makeTx(amountCents, "COP", {
        originalCurrency: "COP",
        originalAmountCents: "500000000",
        trmToAccountCurrency: trm,
        trmSource: "statement_frozen",
      }),
      "all-usd",
    );
    expect(result.converted).toBe(true);
    expect(result.currency).toBe("USD");
    // USD cents: 500,000,000 / 3676.92 ≈ 135,984
    const abs = result.cents > BigInt(0) ? result.cents : -result.cents;
    expect(abs).toBeGreaterThan(BigInt(135_000));
    expect(abs).toBeLessThan(BigInt(137_000));
  });

  it("preserves sign for negative (expense) amounts", () => {
    const result = convertToDisplayCurrency(
      makeTx(BigInt(-100000), "USD", {
        originalCurrency: "USD",
        originalAmountCents: "100000",
        trmToAccountCurrency: 4000,
        trmSource: "statement_frozen",
      }),
      "all-cop",
    );
    expect(result.cents < BigInt(0)).toBe(true);
  });

  it("preserves sign for positive (income) amounts", () => {
    const result = convertToDisplayCurrency(
      makeTx(BigInt(100000), "USD", {
        originalCurrency: "USD",
        originalAmountCents: "100000",
        trmToAccountCurrency: 4000,
        trmSource: "statement_frozen",
      }),
      "all-cop",
    );
    expect(result.cents > BigInt(0)).toBe(true);
  });

  it("uses merged_statement.fx over rawData.fx", () => {
    const liveRate = 4200; // "today's rate" — should NOT be used
    const frozenRate = 3676.92;
    const result = convertToDisplayCurrency(
      {
        amountCents: BigInt(-135984),
        currency: "USD",
        rawData: {
          fx: {
            originalCurrency: "USD",
            originalAmountCents: "135984",
            trmToAccountCurrency: liveRate, // primary (email) fx — stale
            trmSource: "email_implied",
          },
          merged_statement: {
            fx: {
              originalCurrency: "USD",
              originalAmountCents: "135984",
              trmToAccountCurrency: frozenRate, // statement-authoritative
              trmSource: "statement_frozen",
            },
          },
        },
      },
      "all-cop",
    );
    expect(result.appliedTrm).toBe(frozenRate);
    expect(result.converted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing TRM fallback
// ---------------------------------------------------------------------------

describe("convertToDisplayCurrency — missing TRM", () => {
  it("falls back to original currency when no rawData", () => {
    const result = convertToDisplayCurrency(makeTx(BigInt(-100000), "USD"), "all-cop");
    expect(result.converted).toBe(false);
    expect(result.currency).toBe("USD");
    expect(result.cents).toBe(BigInt(-100000));
  });

  it("falls back to original currency when fx block is missing", () => {
    const result = convertToDisplayCurrency(makeTx(BigInt(-100000), "USD", undefined), "all-cop");
    expect(result.converted).toBe(false);
    expect(result.currency).toBe("USD");
  });

  it("falls back to original currency when trmToAccountCurrency is null", () => {
    const result = convertToDisplayCurrency(
      makeTx(BigInt(-100000), "USD", {
        originalCurrency: "USD",
        originalAmountCents: "100000",
        trmToAccountCurrency: null,
        trmSource: "1_to_1",
      }),
      "all-cop",
    );
    expect(result.converted).toBe(false);
    expect(result.currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Bigint arithmetic correctness (no float drift)
// ---------------------------------------------------------------------------

describe("convertToDisplayCurrency — integer arithmetic", () => {
  it("converts large amounts without float drift", () => {
    // $10,000 USD at TRM 4,123.456789 COP/USD
    // Expected: 1_000_000 cents × 4_123.456789 = 4_123_456_789 COP-cents
    const result = convertToDisplayCurrency(
      makeTx(BigInt(1000000), "USD", {
        originalCurrency: "USD",
        originalAmountCents: "1000000",
        trmToAccountCurrency: 4123.456789,
        trmSource: "statement_frozen",
      }),
      "all-cop",
    );
    // float(1_000_000 * 4123.456789) = 4,123,456,789 — check integer precision
    expect(result.cents).toBeGreaterThan(BigInt(4_120_000_000));
    expect(result.cents).toBeLessThan(BigInt(4_125_000_000));
  });
});
