import { describe, expect, it } from "vitest";
import { wompiParser } from "./wompi";

// Minimal HTML scaffold that mimics real Wompi emails.
// Real emails use an HTML4 strict DOCTYPE with a table-based layout.
// PII sanitised: card last-4 replaced with XXXX.
function wrapWompi(body: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<style type="text/css">body { margin: 0; padding: 0; } .footer { font-size: 11px; }</style>
</head>
<body>
<table width="600" align="center" cellpadding="0" cellspacing="0">
  <tr><td>${body}</td></tr>
  <tr><td class="footer"><p>Wompi &mdash; Pagos en l&iacute;nea</p></td></tr>
</table>
</body>
</html>`;
}

const APPROVED_BODY = `
  <p>&nbsp; Tu transacci&oacute;n fue APROBADA &nbsp;</p>
  <p>Hemos procesado exitosamente el pago realizado a SOMOS INTERNET y el dinero ser&aacute; transferido al comercio.</p>
  <p>&nbsp; Estado: &nbsp; APROBADA &nbsp;</p>
  <p>&nbsp; Referencia: &nbsp; WC-1081469-1774479119 &nbsp;</p>
  <p>&nbsp; Transacci&oacute;n #: &nbsp; 1341161-1774479147-18748 &nbsp;</p>
  <p>&nbsp; Monto: &nbsp; COP $137,000 &nbsp;</p>
  <p>&nbsp; M&eacute;todo de pago: &nbsp; Tarjeta MASTERCARD ****XXXX &nbsp;</p>
  <p>&nbsp; Procesador: &nbsp; RBM &nbsp;</p>
`;

describe("wompiParser — approved transaction", () => {
  it("parses a standard APROBADA receipt", () => {
    const html = wrapWompi(APPROVED_BODY);
    const r = wompiParser.parse(html, { receivedAt: new Date("2026-04-19T12:00:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("SOMOS INTERNET");
    expect(r.data.amountCents).toBe(BigInt(13700000));
    expect(r.data.currency).toBe("COP");
    expect(r.data.referenceId).toBe("WC-1081469-1774479119");
    expect(r.data.occurredAt).toEqual(new Date("2026-04-19T12:00:00Z"));
  });

  it("returns needs_review when receivedAt is absent (no wall-clock fallback)", () => {
    const html = wrapWompi(APPROVED_BODY);
    const r = wompiParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("missing_occurred_at");
  });

  it("handles decimal amounts (e.g. COP $1,234.56 = 123456 cents)", () => {
    const html = wrapWompi(`
      <p>Hemos procesado exitosamente el pago realizado a TIENDA EJEMPLO y el dinero ser&aacute; transferido.</p>
      <p>Estado: APROBADA</p>
      <p>Referencia: WC-999-111</p>
      <p>Monto: COP $1,234.56</p>
    `);
    const r = wompiParser.parse(html, { receivedAt: new Date("2026-04-01T00:00:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.amountCents).toBe(BigInt(123456));
    expect(r.data.merchant).toBe("TIENDA EJEMPLO");
  });
});

describe("wompiParser — rejected / non-approved", () => {
  it("skips a RECHAZADA transaction", () => {
    const html = wrapWompi(`
      <p>Tu transacci&oacute;n fue RECHAZADA</p>
      <p>El pago realizado a COMERCIO EJEMPLO no pudo ser procesado.</p>
      <p>Estado: RECHAZADA</p>
      <p>Monto: COP $50,000</p>
    `);
    const r = wompiParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("not_approved");
  });

  it("skips an email with no APROBADA marker", () => {
    const html = wrapWompi(`
      <p>Wompi - Actualizaci&oacute;n de cuenta</p>
      <p>Tu cuenta ha sido actualizada exitosamente.</p>
    `);
    const r = wompiParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("not_approved");
  });
});

describe("wompiParser — needs_review", () => {
  it("returns needs_review when merchant cannot be extracted from APROBADA email", () => {
    const html = wrapWompi(`
      <p>Tu transacci&oacute;n fue APROBADA</p>
      <p>Estado: APROBADA</p>
      <p>Monto: COP $10,000</p>
    `);
    const r = wompiParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("merchant_not_found");
  });

  it("returns needs_review when amount cannot be extracted", () => {
    const html = wrapWompi(`
      <p>Tu transacci&oacute;n fue APROBADA</p>
      <p>Hemos procesado exitosamente el pago realizado a TIENDA TEST y el dinero ser&aacute; transferido.</p>
      <p>Estado: APROBADA</p>
      <p>Referencia: WC-000-111</p>
    `);
    const r = wompiParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("amount_not_found");
  });

  it("handles null referenceId when WC- reference is absent", () => {
    const html = wrapWompi(`
      <p>Tu transacci&oacute;n fue APROBADA</p>
      <p>Hemos procesado exitosamente el pago realizado a OTRO COMERCIO y el dinero ser&aacute; transferido.</p>
      <p>Estado: APROBADA</p>
      <p>Monto: COP $75,000</p>
    `);
    const r = wompiParser.parse(html, { receivedAt: new Date("2026-04-19T12:00:00Z") });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.referenceId).toBeNull();
    expect(r.data.amountCents).toBe(BigInt(7500000));
  });
});
