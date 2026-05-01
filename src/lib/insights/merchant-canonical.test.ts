import { describe, expect, it } from "vitest";
import { canonicalizeMerchant, withCanonical } from "./merchant-canonical";

describe("canonicalizeMerchant", () => {
  // -------------------------------------------------------------------------
  // Null / blank guards
  // -------------------------------------------------------------------------
  it("returns null for null input", () => {
    expect(canonicalizeMerchant(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(canonicalizeMerchant(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(canonicalizeMerchant("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(canonicalizeMerchant("   ")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Clean passthrough (no prefix, no skip)
  // -------------------------------------------------------------------------
  it("returns unchanged clean merchant name", () => {
    expect(canonicalizeMerchant("Didi")).toBe("Didi");
  });

  it("returns unchanged person name", () => {
    expect(canonicalizeMerchant("Aida Mercedes Maldonado Ramos")).toBe(
      "Aida Mercedes Maldonado Ramos",
    );
  });

  it("returns unchanged restaurant name", () => {
    expect(canonicalizeMerchant("LA MARQUESA MGB")).toBe("LA MARQUESA MGB");
  });

  it("returns unchanged utility merchant", () => {
    expect(canonicalizeMerchant("UNE TELCO UNE PAGO EXP")).toBe("UNE TELCO UNE PAGO EXP");
  });

  it("returns balance adjustment unchanged", () => {
    expect(canonicalizeMerchant("Balance adjustment")).toBe("Balance adjustment");
  });

  // -------------------------------------------------------------------------
  // Gateway prefix stripping
  // -------------------------------------------------------------------------
  it("strips DLO* prefix", () => {
    expect(canonicalizeMerchant("DLO*Didi")).toBe("Didi");
  });

  it("strips DLO* prefix and preserves case", () => {
    expect(canonicalizeMerchant("DLO*DiDi Food CO Pay")).toBe("DiDi Food CO Pay");
  });

  it("strips MERCADO PAGO* uppercase prefix", () => {
    expect(canonicalizeMerchant("MERCADO PAGO*JETSMAR")).toBe("JETSMAR");
  });

  it("strips Mercado Pago* title-case prefix", () => {
    expect(canonicalizeMerchant("Mercado Pago*PASARELAE")).toBe("PASARELAE");
  });

  it("strips PAYU* prefix", () => {
    expect(canonicalizeMerchant("PAYU*SOMOS INTERNET")).toBe("SOMOS INTERNET");
  });

  it("strips WOMPI* prefix", () => {
    expect(canonicalizeMerchant("WOMPI*SOMOS INTERNET")).toBe("SOMOS INTERNET");
  });

  it("strips PAYU space-separated variant", () => {
    expect(canonicalizeMerchant("PAYU SOMETHING")).toBe("SOMETHING");
  });

  it("strips PayPal* prefix", () => {
    expect(canonicalizeMerchant("PayPal*SomeMerchant")).toBe("SomeMerchant");
  });

  // -------------------------------------------------------------------------
  // MERCADOPAGO opaque case — must NOT strip
  // -------------------------------------------------------------------------
  it("does NOT strip MERCADOPAGO COLOMBIA — opaque gateway case", () => {
    expect(canonicalizeMerchant("MERCADOPAGO COLOMBIA")).toBe("MERCADOPAGO COLOMBIA");
  });

  // -------------------------------------------------------------------------
  // Whitespace handling
  // -------------------------------------------------------------------------
  it("collapses leading/trailing whitespace", () => {
    expect(canonicalizeMerchant("  DLO*Didi  ")).toBe("Didi");
  });

  it("collapses internal whitespace after stripping prefix", () => {
    expect(canonicalizeMerchant("DLO*  Didi")).toBe("Didi");
  });

  // -------------------------------------------------------------------------
  // Skip patterns
  // -------------------------------------------------------------------------
  it("returns null for Pago TC *7291", () => {
    expect(canonicalizeMerchant("Pago TC *7291")).toBeNull();
  });

  it("returns null for Pago TC *2575", () => {
    expect(canonicalizeMerchant("Pago TC *2575")).toBeNull();
  });

  it("returns null for Transferencia a cuenta *91218413213", () => {
    expect(canonicalizeMerchant("Transferencia a cuenta *91218413213")).toBeNull();
  });

  it("returns null for Pago QR a llave 0088044474", () => {
    expect(canonicalizeMerchant("Pago QR a llave 0088044474")).toBeNull();
  });

  it("returns null for AJUSTE INTERES AHORROS DB", () => {
    expect(canonicalizeMerchant("AJUSTE INTERES AHORROS DB")).toBeNull();
  });

  it("returns null for APORTES EN LINEA", () => {
    expect(canonicalizeMerchant("APORTES EN LINEA")).toBeNull();
  });

  it("returns null for TRANSFERENCIA CTA SUC VIRTUAL", () => {
    expect(canonicalizeMerchant("TRANSFERENCIA CTA SUC VIRTUAL")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // W1 regression — skip pattern applied AFTER gateway strip
  // -------------------------------------------------------------------------
  it("returns null for DLO*AJUSTE INTERES AHORROS DB (skip after prefix strip)", () => {
    expect(canonicalizeMerchant("DLO*AJUSTE INTERES AHORROS DB")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // W2 — PAYU/WOMPI over-strip prevention (require explicit delimiter)
  // -------------------------------------------------------------------------
  it("does NOT strip PAYULATAM — no delimiter after PAYU", () => {
    expect(canonicalizeMerchant("PAYULATAM")).toBe("PAYULATAM");
  });

  it("does NOT strip WOMPILATAM — no delimiter after WOMPI", () => {
    expect(canonicalizeMerchant("WOMPILATAM")).toBe("WOMPILATAM");
  });

  it("still strips PAYU* with asterisk delimiter", () => {
    expect(canonicalizeMerchant("PAYU*SOMOS INTERNET")).toBe("SOMOS INTERNET");
  });

  it("still strips PAYU with space delimiter", () => {
    expect(canonicalizeMerchant("PAYU SOMETHING")).toBe("SOMETHING");
  });
});

describe("canonicalizeMerchant — idempotency", () => {
  // -------------------------------------------------------------------------
  // S1 — idempotency tests
  // -------------------------------------------------------------------------
  it("is idempotent — re-canonicalizing returns the same value", () => {
    const once = canonicalizeMerchant("DLO*Didi");
    const twice = canonicalizeMerchant(once);
    expect(once).toBe("Didi");
    expect(twice).toBe("Didi");
    expect(once).toBe(twice);
  });

  it("skip pattern then re-canonicalize null is null", () => {
    const result = canonicalizeMerchant("Pago TC *7291");
    expect(result).toBeNull();
    expect(canonicalizeMerchant(result)).toBeNull();
  });
});

describe("withCanonical", () => {
  it("returns both merchant and canonicalMerchant", () => {
    expect(withCanonical("DLO*Didi")).toEqual({
      merchant: "DLO*Didi",
      canonicalMerchant: "Didi",
    });
  });

  it("returns null merchant and null canonical for null input", () => {
    expect(withCanonical(null)).toEqual({
      merchant: null,
      canonicalMerchant: null,
    });
  });

  it("returns null merchant and null canonical for blank input", () => {
    expect(withCanonical("   ")).toEqual({
      merchant: null,
      canonicalMerchant: null,
    });
  });

  it("preserves the raw merchant value (not the canonicalized one)", () => {
    // merchant should be the trimmed raw value, NOT the canonical
    expect(withCanonical("MERCADO PAGO*JETSMAR")).toEqual({
      merchant: "MERCADO PAGO*JETSMAR",
      canonicalMerchant: "JETSMAR",
    });
  });

  it("preserves raw merchant for skip pattern, canonical is null", () => {
    // merchant stores the raw value (audit); canonicalMerchant is null for skips
    expect(withCanonical("Pago TC *1234")).toEqual({
      merchant: "Pago TC *1234",
      canonicalMerchant: null,
    });
  });

  it("both are the same for a clean merchant with no prefix", () => {
    expect(withCanonical("Didi")).toEqual({
      merchant: "Didi",
      canonicalMerchant: "Didi",
    });
  });
});
