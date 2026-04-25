import { describe, expect, it } from "vitest";
import { mercadoPagoParser } from "./mercado-pago";

// Minimal HTML scaffold that mimics real Mercado Pago transactional emails.
// PII sanitised: card last-4 replaced, operation number neutralised.
function wrapMercadoPago(body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>Mercado Pago</title>
<style type="text/css">body{margin:0;font-family:Arial,sans-serif;}</style>
</head>
<body>
<table width="600" align="center" cellpadding="0" cellspacing="0">
  <tr><td>${body}</td></tr>
  <tr><td><p>Pago procesado por Mercado Pago.</p></td></tr>
  <tr><td><p>Cancelar suscripci&oacute;n</p></td></tr>
</table>
</body>
</html>`;
}

// Real production shape (purchase) — duplicated merchant due to email rendering
const PURCHASE_BODY = `
  <p>Le compraste a EMPRESA DE MEDICINA INTEGRAL EMI S.A.S. SERVICIO DE AMBULAN</p>
  <p>Le compraste a EMPRESA DE MEDICINA INTEGRAL EMI S.A.S. SERVICIO DE AMBULAN</p>
  <p>Tu pago fue aprobado</p>
  <p>Pagaste $ 152.800</p>
  <p>Mastercard Cr&eacute;dito **** XXXX</p>
  <p>1 cuota de $ 152.800</p>
  <p>Nombre en el resumen de tu tarjeta</p>
  <p>Mercado Pago*PASARELAEN.</p>
  <p>N.&deg; de operaci&oacute;n 155335418627</p>
  <p>Fecha y hora 23 de abril a las 11:26 hs</p>
`;

describe("mercadoPagoParser — purchase", () => {
  it("parses a real purchase receipt (duplicated merchant, period-thousands)", () => {
    const html = wrapMercadoPago(PURCHASE_BODY);
    const r = mercadoPagoParser.parse(html, { receivedAt: new Date("2026-04-23T15:00:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("EMPRESA DE MEDICINA INTEGRAL EMI S.A.S. SERVICIO DE AMBULAN");
    // $ 152.800 = 152 800 COP = 15 280 000 cents
    expect(r.data.amountCents).toBe(BigInt(15280000));
    expect(r.data.currency).toBe("COP");
    expect(r.data.referenceId).toBe("155335418627");
    // 23 de abril a las 11:26 Bogotá (UTC-5) → 16:26 UTC, year from receivedAt = 2026
    expect(r.data.occurredAt).toEqual(new Date("2026-04-23T16:26:00Z"));
  });

  it("parses a purchase with explicit simple merchant name", () => {
    const html = wrapMercadoPago(`
      <p>Le compraste a RAPPI COLOMBIA</p>
      <p>Tu pago fue aprobado</p>
      <p>Pagaste $ 35.900</p>
      <p>Mastercard Cr&eacute;dito **** XXXX</p>
      <p>N.&deg; de operaci&oacute;n 987654321</p>
      <p>Fecha y hora 5 de marzo a las 20:10 hs</p>
    `);
    const r = mercadoPagoParser.parse(html, { receivedAt: new Date("2026-03-05T23:00:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("RAPPI COLOMBIA");
    // $ 35.900 = 35 900 COP = 3 590 000 cents
    expect(r.data.amountCents).toBe(BigInt(3590000));
    expect(r.data.referenceId).toBe("987654321");
    // 5 de marzo 20:10 Bogotá = 2026-03-06 01:10 UTC
    expect(r.data.occurredAt).toEqual(new Date("2026-03-06T01:10:00Z"));
  });

  it("handles decimal amount (comma separator)", () => {
    const html = wrapMercadoPago(`
      <p>Le compraste a TIENDA TEST</p>
      <p>Tu pago fue aprobado</p>
      <p>Pagaste $ 1.234,56</p>
      <p>N.&deg; de operaci&oacute;n 111222333</p>
      <p>Fecha y hora 10 de enero a las 09:05 hs</p>
    `);
    const r = mercadoPagoParser.parse(html, { receivedAt: new Date("2026-01-10T15:00:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    // $ 1.234,56 = 1 234.56 COP = 123 456 cents
    expect(r.data.amountCents).toBe(BigInt(123456));
  });
});

describe("mercadoPagoParser — promotional emails (skip)", () => {
  it("skips a promotional email with no Pagaste or Le compraste a", () => {
    const html = wrapMercadoPago(`
      <p>Con Mercado Pago aprovecha 3 cuotas sin inter&eacute;s en Americanino, Esprit y muchas m&aacute;s marcas.</p>
      <p>#LoMejorEstaLlegando</p>
      <p>Te enviamos este e-mail a example@gmail.com porque elegiste recibir informaci&oacute;n.</p>
      <p>Cancelar suscripci&oacute;n</p>
    `);
    const r = mercadoPagoParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("non_transactional");
  });

  it("skips an email with only marketing copy (no transaction signals)", () => {
    const html = wrapMercadoPago(`
      <p>Para que te des un gustico pagando con Mercado Pago.</p>
      <p>Vigilado SFC</p>
    `);
    const r = mercadoPagoParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("non_transactional");
  });
});

describe("mercadoPagoParser — year-boundary (Dec 31 / Jan 1 UTC)", () => {
  it("assigns 2025 to a Dec-31 body when receivedAt is already Jan 1 UTC", () => {
    // Payment at 23:30 Bogotá on Dec 31 = 04:30 UTC on Jan 1 next year.
    // Gmail's internalDate is UTC, so receivedAt lands in the new year.
    // The body says "31 de diciembre" — year must be 2025, not 2026.
    const html = wrapMercadoPago(`
      <p>Le compraste a TIENDA NOCHEVIEJA</p>
      <p>Tu pago fue aprobado</p>
      <p>Pagaste $ 50.000</p>
      <p>N.&deg; de operaci&oacute;n 999888777</p>
      <p>Fecha y hora 31 de diciembre a las 23:30 hs</p>
    `);
    // receivedAt is 2026-01-01T04:30:00Z (04:30 UTC = 23:30 Bogotá on Dec 31 2025)
    const r = mercadoPagoParser.parse(html, { receivedAt: new Date("2026-01-01T04:30:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    // 31 de diciembre 23:30 Bogotá (UTC-5) → 2025-12-31 23:30 + 5h = 2026-01-01T04:30:00Z.
    // The UTC timestamp crosses into 2026 by definition (it IS Jan 1 UTC), but the
    // LOCAL year (Bogotá) is 2025. We verify by checking the full timestamp is correct.
    expect(r.data.occurredAt).toEqual(new Date("2026-01-01T04:30:00Z"));
  });

  it("keeps the same year for a normal Dec-15 body with Dec receivedAt", () => {
    const html = wrapMercadoPago(`
      <p>Le compraste a TIENDA NAVIDAD</p>
      <p>Tu pago fue aprobado</p>
      <p>Pagaste $ 100.000</p>
      <p>N.&deg; de operaci&oacute;n 123456789</p>
      <p>Fecha y hora 15 de diciembre a las 14:00 hs</p>
    `);
    const r = mercadoPagoParser.parse(html, { receivedAt: new Date("2025-12-15T20:00:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.occurredAt.getUTCFullYear()).toBe(2025);
  });
});

describe("mercadoPagoParser — needs_review", () => {
  it("returns needs_review when Pagaste is present but amount cannot be parsed", () => {
    const html = wrapMercadoPago(`
      <p>Le compraste a TIENDA TEST</p>
      <p>Tu pago fue aprobado</p>
      <p>Pagaste un monto no especificado</p>
      <p>Fecha y hora 10 de enero a las 09:05 hs</p>
    `);
    const r = mercadoPagoParser.parse(html, { receivedAt: new Date("2026-01-10T15:00:00Z") });
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("amount_not_found");
  });

  it("returns needs_review when date is missing and no receivedAt fallback", () => {
    const html = wrapMercadoPago(`
      <p>Le compraste a TIENDA TEST</p>
      <p>Tu pago fue aprobado</p>
      <p>Pagaste $ 50.000</p>
      <p>N.&deg; de operaci&oacute;n 111</p>
    `);
    // No receivedAt provided
    const r = mercadoPagoParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("missing_occurred_at");
  });
});
