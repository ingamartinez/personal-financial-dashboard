import { describe, expect, it } from "vitest";
import { emailReceiptGateway } from "@/lib/db/schema";
import { GATEWAYS, buildSenderQuery, getGatewayById } from "./registry";

describe("gmail/registry", () => {
  it("covers every enum value in email_receipt_gateway", () => {
    const enumIds = new Set(emailReceiptGateway.enumValues);
    const registryIds = new Set(GATEWAYS.map((g) => g.id));
    expect(registryIds).toEqual(enumIds);
  });

  it("marks bancolombia and arq as ingest mode, all other gateways as enrich", () => {
    const byId = new Map(GATEWAYS.map((g) => [g.id, g] as const));
    expect(byId.get("bancolombia")!.mode).toBe("ingest");
    // ARQ is capture-only (#509 step 0): emails persisted but not processed
    // until the real parser lands in #508.
    expect(byId.get("arq")!.mode).toBe("ingest");
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
    expect(getGatewayById("mercado_pago").bankDescriptionRegex!.test("MERCADOPAGO COLOMBIA")).toBe(
      true,
    );
    expect(getGatewayById("payu").bankDescriptionRegex!.test("PAYU*TIENDA")).toBe(true);
    expect(getGatewayById("wompi").bankDescriptionRegex!.test("WOMPI*SERVICIO")).toBe(true);
    expect(getGatewayById("apple").bankDescriptionRegex!.test("APPLE.COM/BILL")).toBe(true);
    expect(getGatewayById("paypal").bankDescriptionRegex!.test("PAYPAL *TIENDA")).toBe(true);
  });

  it("ingest gateways expose bankDescriptionRegex=null (matcher skips them)", () => {
    const bancolombia = getGatewayById("bancolombia");
    expect(bancolombia.mode).toBe("ingest");
    expect(bancolombia.bankDescriptionRegex).toBeNull();

    const arq = getGatewayById("arq");
    expect(arq.mode).toBe("ingest");
    expect(arq.bankDescriptionRegex).toBeNull();
  });

  // Sentinel — ARQ (#509): capture-only step 0 while #508 designs the real
  // parser. Both current domain (@arqfinance.com) and legacy DolarApp domain
  // (@dolarapp.com) must be present so emails from either brand are harvested.
  it("arq covers both current arqfinance.com and legacy dolarapp.com domains", () => {
    const cfg = getGatewayById("arq");
    expect(cfg.senderQueries).toContain("from:(@arqfinance.com)");
    expect(cfg.senderQueries).toContain("from:(@dolarapp.com)");
  });

  it("getGatewayById throws for an unknown id", () => {
    // @ts-expect-error — intentionally out-of-enum to exercise runtime guard.
    expect(() => getGatewayById("stripe")).toThrow(/unknown gateway/);
  });

  // Sentinel — discovered in prod (#465): expanding from email-specific to
  // domain-level so the engine catches `noreply@` + `no_reply@` +
  // `do_not_reply@` and future Apple senders at that domain without code
  // changes. If Apple rotates the local-part, we just keep working.
  it("apple uses domain-level @email.apple.com (catches noreply/no_reply/do_not_reply variants)", () => {
    expect(getGatewayById("apple").senderQueries).toContain("from:(@email.apple.com)");
  });

  // Sentinel — paypal moved from `service@paypal.com` + `service@intl.paypal.com`
  // to domain-level for future-proofing. Verifies the root domain is there.
  it("paypal includes domain-level @paypal.com", () => {
    expect(getGatewayById("paypal").senderQueries).toContain("from:(@paypal.com)");
  });

  // Sentinel — bancolombia expanded to cover the transactional alerts domain
  // plus the monthly statements domain surfaced by prod discovery (#465).
  it("bancolombia covers alerts + bank.com.co + extractos domains", () => {
    const cfg = getGatewayById("bancolombia");
    expect(cfg.senderQueries).toContain("from:(@an.notificacionesbancolombia.com)");
    expect(cfg.senderQueries).toContain("from:(@bancolombia.com.co)");
    expect(cfg.senderQueries).toContain("from:(@extractos.documentosbancolombia.com)");
  });
});
