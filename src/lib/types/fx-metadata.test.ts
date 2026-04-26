import { describe, it, expect } from "vitest";
import {
  FxMetadataSchema,
  parseFxMetadata,
  extractFxMetadata,
  extractFxMetadataWithFallback,
} from "./fx-metadata";

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("FxMetadataSchema", () => {
  it("accepts a valid COP-native block", () => {
    const result = FxMetadataSchema.safeParse({
      originalCurrency: "COP",
      originalAmountCents: "500000",
      trmToAccountCurrency: null,
      trmSource: "1_to_1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a USD block with frozen TRM", () => {
    const result = FxMetadataSchema.safeParse({
      originalCurrency: "USD",
      originalAmountCents: "135984",
      trmToAccountCurrency: 3676.92,
      trmSource: "email_implied",
      copAmountCents: "500000000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trmToAccountCurrency).toBe(3676.92);
      expect(result.data.copAmountCents).toBe("500000000");
    }
  });

  it("accepts USDc with statement_frozen source", () => {
    const result = FxMetadataSchema.safeParse({
      originalCurrency: "USDc",
      originalAmountCents: "99900",
      trmToAccountCurrency: 4123.45,
      trmSource: "statement_frozen",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing originalCurrency", () => {
    const result = FxMetadataSchema.safeParse({
      originalAmountCents: "100",
      trmToAccountCurrency: null,
      trmSource: "1_to_1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects float originalAmountCents", () => {
    const result = FxMetadataSchema.safeParse({
      originalCurrency: "COP",
      originalAmountCents: "100.50",
      trmToAccountCurrency: null,
      trmSource: "1_to_1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown trmSource", () => {
    const result = FxMetadataSchema.safeParse({
      originalCurrency: "COP",
      originalAmountCents: "100",
      trmToAccountCurrency: null,
      trmSource: "live_rate",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown originalCurrency", () => {
    const result = FxMetadataSchema.safeParse({
      originalCurrency: "EUR",
      originalAmountCents: "100",
      trmToAccountCurrency: null,
      trmSource: "1_to_1",
    });
    expect(result.success).toBe(false);
  });

  it("accepts 'unknown' trmSource for cross-currency without TRM", () => {
    const result = FxMetadataSchema.safeParse({
      originalCurrency: "USD",
      originalAmountCents: "100",
      trmToAccountCurrency: null,
      trmSource: "unknown",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFxMetadata
// ---------------------------------------------------------------------------

describe("parseFxMetadata", () => {
  it("returns parsed metadata for valid input", () => {
    const result = parseFxMetadata({
      originalCurrency: "USD",
      originalAmountCents: "135984",
      trmToAccountCurrency: 3676.92,
      trmSource: "email_implied",
    });
    expect(result).not.toBeNull();
    expect(result?.trmToAccountCurrency).toBe(3676.92);
  });

  it("returns null for malformed input", () => {
    const result = parseFxMetadata({ foo: "bar" });
    expect(result).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseFxMetadata(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseFxMetadata(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFxMetadata
// ---------------------------------------------------------------------------

describe("extractFxMetadata", () => {
  it("returns null when rawData is null", () => {
    expect(extractFxMetadata(null)).toBeNull();
  });

  it("returns null when fx key is absent", () => {
    expect(extractFxMetadata({ kind: "purchase" })).toBeNull();
  });

  it("extracts valid fx block from rawData", () => {
    const result = extractFxMetadata({
      fx: {
        originalCurrency: "COP",
        originalAmountCents: "50000",
        trmToAccountCurrency: null,
        trmSource: "1_to_1",
      },
    });
    expect(result).not.toBeNull();
    expect(result?.originalCurrency).toBe("COP");
  });
});

// ---------------------------------------------------------------------------
// extractFxMetadataWithFallback
// ---------------------------------------------------------------------------

describe("extractFxMetadataWithFallback", () => {
  it("prefers merged_statement.fx over rawData.fx", () => {
    const result = extractFxMetadataWithFallback({
      fx: {
        originalCurrency: "USD",
        originalAmountCents: "100",
        trmToAccountCurrency: 4000,
        trmSource: "email_implied",
      },
      merged_statement: {
        fx: {
          originalCurrency: "USD",
          originalAmountCents: "100",
          trmToAccountCurrency: 3676.92,
          trmSource: "statement_frozen",
        },
      },
    });
    expect(result?.trmSource).toBe("statement_frozen");
    expect(result?.trmToAccountCurrency).toBe(3676.92);
  });

  it("falls back to rawData.fx when merged_statement.fx is absent", () => {
    const result = extractFxMetadataWithFallback({
      fx: {
        originalCurrency: "USD",
        originalAmountCents: "100",
        trmToAccountCurrency: 4000,
        trmSource: "email_implied",
      },
    });
    expect(result?.trmSource).toBe("email_implied");
  });

  it("returns null when both are absent", () => {
    expect(extractFxMetadataWithFallback({})).toBeNull();
    expect(extractFxMetadataWithFallback(null)).toBeNull();
  });
});
