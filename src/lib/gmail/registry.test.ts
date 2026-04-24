import { describe, expect, it } from "vitest";
import { emailReceiptGateway } from "@/lib/db/schema";
import { GATEWAYS, buildSenderQuery, getGatewayById } from "./registry";

describe("gmail/registry", () => {
  it("covers every enum value in email_receipt_gateway", () => {
    const enumIds = new Set(emailReceiptGateway.enumValues);
    const registryIds = new Set(GATEWAYS.map((g) => g.id));
    expect(registryIds).toEqual(enumIds);
  });

  it("marks bancolombia as ingest mode, all other gateways as enrich", () => {
    const byId = new Map(GATEWAYS.map((g) => [g.id, g] as const));
    expect(byId.get("bancolombia")!.mode).toBe("ingest");
    expect(byId.get("mercado_pago")!.mode).toBe("enrich");
    expect(byId.get("payu")!.mode).toBe("enrich");
    expect(byId.get("wompi")!.mode).toBe("enrich");
    expect(byId.get("apple")!.mode).toBe("enrich");
    expect(byId.get("paypal")!.mode).toBe("enrich");
  });

  it("buildSenderQuery returns a single fragment when only one sender is configured", () => {
    const cfg = getGatewayById("wompi");
    expect(cfg.senderQueries).toHaveLength(1);
    expect(buildSenderQuery(cfg)).toBe("from:(@wompi.co)");
  });

  it("buildSenderQuery ORs multiple fragments inside parens", () => {
    const cfg = getGatewayById("mercado_pago");
    const q = buildSenderQuery(cfg);
    expect(q.startsWith("(")).toBe(true);
    expect(q.endsWith(")")).toBe(true);
    expect(q).toContain(" OR ");
    for (const frag of cfg.senderQueries) expect(q).toContain(frag);
  });

  it("bankDescriptionRegex matches canonical bank descriptions for enrich gateways", () => {
    expect(getGatewayById("mercado_pago").bankDescriptionRegex.test("MERCADOPAGO COLOMBIA")).toBe(
      true,
    );
    expect(getGatewayById("payu").bankDescriptionRegex.test("PAYU*TIENDA")).toBe(true);
    expect(getGatewayById("wompi").bankDescriptionRegex.test("WOMPI*SERVICIO")).toBe(true);
    expect(getGatewayById("apple").bankDescriptionRegex.test("APPLE.COM/BILL")).toBe(true);
    expect(getGatewayById("paypal").bankDescriptionRegex.test("PAYPAL *TIENDA")).toBe(true);
  });

  it("bancolombia bankDescriptionRegex never matches (ingest gateways skip matcher)", () => {
    const cfg = getGatewayById("bancolombia");
    expect(cfg.bankDescriptionRegex.test("BANCOLOMBIA")).toBe(false);
    expect(cfg.bankDescriptionRegex.test("anything")).toBe(false);
    expect(cfg.bankDescriptionRegex.test("")).toBe(false);
  });

  it("getGatewayById throws for an unknown id", () => {
    // @ts-expect-error — intentionally out-of-enum to exercise runtime guard.
    expect(() => getGatewayById("stripe")).toThrow(/unknown gateway/);
  });
});
