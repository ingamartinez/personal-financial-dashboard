import { describe, expect, it } from "vitest";
import { payuParser } from "./payu";

// Minimal HTML scaffold that mimics real PayU emails.
// PII sanitised: transaction UUIDs replaced with placeholders, email replaced.
function wrapPayU(body: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<title>PayU</title>
<style type="text/css">body { margin: 0; font-family: Arial, sans-serif; }</style>
</head>
<body>
<table width="600" align="center" cellpadding="0" cellspacing="0">
  <tr><td>PayU</td></tr>
  <tr><td>${body}</td></tr>
  <tr><td><p>www.payu.com</p></td></tr>
</table>
</body>
</html>`;
}

const APPROVED_CORFERIAS = `
  <p>Tu transacci&#243;n ha sido aprobada</p>
  <p>Hola Alejandro Martinez, La transacci&#243;n aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb realizada en CORFERIAS , fue aprobada .</p>
  <p>Datos de la transacci&#243;n:</p>
  <p>Descripci&#243;n a&#241;o=2026; evento=COMIC CON BOGOTA; referencia=CORBL-18622</p>
  <p>Referencia CORBL-18622</p>
  <p>Valor 137000</p>
  <p>Moneda COP</p>
  <p>Fecha 2026-04-22 13:11:21</p>
  <p>Medio de Pago/Franquicia VISA</p>
`;

const APPROVED_CINEMARK = `
  <p>Tu transacci&#243;n ha sido aprobada</p>
  <p>Hola Alejandro Rafael Martinez Maldonado, La transacci&#243;n aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb realizada en CINEMARK COLOMBIA S.A.S , fue aprobada .</p>
  <p>Datos de la transacci&#243;n:</p>
  <p>Descripci&#243;n Arkadia_2424_Jun 04 2026</p>
  <p>Referencia 3aac1d8e-c560-4e41-b93e-8a3f563857e2</p>
  <p>Valor 92000</p>
  <p>Moneda COP</p>
  <p>Fecha 2026-04-13 09:18:35</p>
  <p>Medio de Pago/Franquicia MASTERCARD</p>
`;

describe("payuParser — approved transactions", () => {
  it("parses CORFERIAS approved receipt (VISA)", () => {
    const html = wrapPayU(APPROVED_CORFERIAS);
    const r = payuParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("CORFERIAS");
    expect(r.data.amountCents).toBe(BigInt(13700000));
    expect(r.data.currency).toBe("COP");
    expect(r.data.referenceId).toBe("CORBL-18622");
    // 2026-04-22 13:11:21 Bogotá (UTC-5) = 2026-04-22 18:11:21 UTC
    expect(r.data.occurredAt).toEqual(new Date("2026-04-22T18:11:21Z"));
  });

  it("parses CINEMARK approved receipt (MASTERCARD, UUID reference)", () => {
    const html = wrapPayU(APPROVED_CINEMARK);
    const r = payuParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("CINEMARK COLOMBIA S.A.S");
    expect(r.data.amountCents).toBe(BigInt(9200000));
    expect(r.data.currency).toBe("COP");
    // UUID reference should be captured
    expect(r.data.referenceId).toBe("3aac1d8e-c560-4e41-b93e-8a3f563857e2");
    // 2026-04-13 09:18:35 Bogotá = 2026-04-13 14:18:35 UTC
    expect(r.data.occurredAt).toEqual(new Date("2026-04-13T14:18:35Z"));
  });
});

describe("payuParser — rejected transactions", () => {
  it("skips a fue rechazada email", () => {
    const html = wrapPayU(`
      <p>Uno de tus pagos fue rechazado</p>
      <p>Hola Alejandro Martinez, La transacci&#243;n xxxxxx realizada en CINEMARK COLOMBIA S.A.S , fue rechazada .</p>
      <p>Referencia 4825caf3-xxxx-xxxx-xxxx-xxxxxx</p>
      <p>Valor 92000</p>
      <p>Moneda COP</p>
      <p>Fecha 2026-04-13 09:18:35</p>
    `);
    const r = payuParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("rejected");
  });

  it("skips email with 'rechazada' anywhere in body", () => {
    const html = wrapPayU(`
      <p>La transacci&#243;n fue rechazada por fondos insuficientes.</p>
      <p>Tu pago no fue procesado.</p>
    `);
    const r = payuParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("rejected");
  });
});

describe("payuParser — card registration", () => {
  it("skips a card registration email", () => {
    const html = wrapPayU(`
      <p>Tarjeta registrada desde Chrome en Windows</p>
      <p>Hola, Tu tarjeta ha sido registrada para agilizar tus pagos con PayU.</p>
      <p>411054******XXXX</p>
    `);
    const r = payuParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("card_registration");
  });
});

describe("payuParser — needs_review", () => {
  it("returns needs_review for unknown PayU email type", () => {
    const html = wrapPayU(`
      <p>PayU - Actualizaci&#243;n de cuenta</p>
      <p>Tu contrase&#241;a ha sido actualizada.</p>
    `);
    const r = payuParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("unknown_payu_email_type");
  });

  it("falls back to receivedAt when Fecha field is missing", () => {
    const html = wrapPayU(`
      <p>Tu transacci&#243;n ha sido aprobada</p>
      <p>La transacci&#243;n xxxxxx realizada en TIENDA TEST , fue aprobada .</p>
      <p>Referencia REF-001</p>
      <p>Valor 50000</p>
      <p>Moneda COP</p>
    `);
    const receivedAt = new Date("2026-04-15T10:00:00Z");
    const r = payuParser.parse(html, { receivedAt });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.occurredAt).toEqual(receivedAt);
    expect(r.data.amountCents).toBe(BigInt(5000000));
  });

  it("returns needs_review when Fecha missing and no receivedAt", () => {
    const html = wrapPayU(`
      <p>Tu transacci&#243;n ha sido aprobada</p>
      <p>La transacci&#243;n xxxxxx realizada en TIENDA TEST , fue aprobada .</p>
      <p>Referencia REF-001</p>
      <p>Valor 50000</p>
      <p>Moneda COP</p>
    `);
    const r = payuParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("missing_occurred_at");
  });
});
