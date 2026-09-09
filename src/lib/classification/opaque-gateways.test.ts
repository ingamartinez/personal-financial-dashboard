// #812: unit tests for the opaque-payment-gateway matcher used by classify-sweep
// to decide when a row must abstain instead of guessing.

import { describe, expect, it } from "vitest";
import { matchOpaqueGateway } from "./opaque-gateways";

describe("matchOpaqueGateway", () => {
  it.each([
    ["MERCADOPAGO COLOMBIA", "mercado_pago"],
    ["MERCADO PAGO LIMITAD", "mercado_pago"],
    ["MERCPAGO*PASARELAEMI", "mercado_pago"],
    ["Mercado Pago*PASARELAE", "mercado_pago"],
    ["PAYU COLOMBIA SAS", "payu"],
    ["WOMPI*TIENDA123", "wompi"],
  ])("matches %s -> %s", (description, expected) => {
    expect(matchOpaqueGateway([description])).toBe(expected);
  });

  it("falls back to unknown_pasarela for a generic gateway shape not in the named list", () => {
    expect(matchOpaqueGateway(["ACME*PASARELA PAGOS"])).toBe("unknown_pasarela");
  });

  it("does NOT match a real merchant that merely transacts through a gateway (#812 negative case: AMAZON tx 1407)", () => {
    expect(matchOpaqueGateway(["AMAZON MKTPLACE PMTS"])).toBeNull();
  });

  it("does not match an unrelated description", () => {
    expect(matchOpaqueGateway(["NETFLIX.COM"])).toBeNull();
  });

  it("checks every candidate string, not just the first", () => {
    expect(matchOpaqueGateway([null, undefined, "some merchant", "MERCADOPAGO COLOMBIA"])).toBe(
      "mercado_pago",
    );
  });

  it("returns null for an empty candidate list", () => {
    expect(matchOpaqueGateway([])).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(matchOpaqueGateway(["mercadopago colombia"])).toBe("mercado_pago");
  });
});
