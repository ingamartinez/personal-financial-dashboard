import { describe, expect, it } from "vitest";
import { paypalParser } from "./paypal";

// Minimal HTML scaffold that mirrors real PayPal email structure.
// PII sanitised: real names/emails replaced with placeholders,
// transaction IDs replaced with UPPERCASE synthetic IDs.
// Real prod HTML never enters this repo — synthetic templates only.
function wrapPayPal(body: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<title>PayPal</title>
<style type="text/css">body { margin: 0; font-family: Arial, sans-serif; }</style>
</head>
<body>
<table width="600" align="center" cellpadding="0" cellspacing="0">
  <tr><td>${body}</td></tr>
  <tr><td>Contacto y ayuda | Seguridad | Aplicaciones</td></tr>
  <tr><td>Copyright &copy; 1999-2026 PayPal. Todos los derechos reservados.</td></tr>
  <tr><td>PayPal RT001736:es_XC(es-CO):1.7.0:abc123</td></tr>
</table>
</body>
</html>`;
}

// ── Template A: direct payment receipt ─────────────────────────────────────

function buildDirectPaymentHtml(opts: {
  merchant: string;
  amountFormatted: string; // e.g. "$29.900 COP" or "€2,50 EUR"
  txId: string;
  date: string; // DD/MM/YYYY
}): string {
  return wrapPayPal(`
    <p>Recibo de su pago a ${opts.merchant}</p>
    <p>Test User, envi&oacute; un pago correctamente.</p>
    <p>Hola, Test User: Ha pagado ${opts.amountFormatted} a ${opts.merchant} Ver o administrar pago</p>
    <p>Id. de transacci&oacute;n ${opts.txId}</p>
    <p>Fecha de la transacci&oacute;n ${opts.date}</p>
    <p>Comercio ${opts.merchant} billing@example.com</p>
    <p>Descripci&oacute;n Precio unitario Cant. Importe</p>
    <p>Product ${opts.amountFormatted} 1 ${opts.amountFormatted}</p>
    <p>Subtotal ${opts.amountFormatted} Total ${opts.amountFormatted} Pago ${opts.amountFormatted}</p>
    <p>Pago enviado a billing@example.com</p>
  `);
}

// ── Template B: recurring/automatic payment receipt ─────────────────────────

function buildAutoPaymentHtml(opts: {
  merchant: string;
  amountFormatted: string; // e.g. "$ 6,99 USD"
  currency: string; // e.g. "USD"
  txId: string;
  date: string; // "D de MES de YYYY"
  localEquivalent?: string; // e.g. "$ 30.885 COP" (optional field)
}): string {
  const localLine = opts.localEquivalent
    ? `<p>Importe total de esta transacci&oacute;n ${opts.localEquivalent}</p>`
    : "";
  return wrapPayPal(`
    <p>Envi&oacute; un pago autom&aacute;tico a ${opts.merchant}</p>
    <p>Test User, aqu&iacute; tiene su recibo.</p>
    <p>Hola, Test User: Gracias por su pago a ${opts.merchant}.</p>
    <p>Acerca de su pago</p>
    <p>Id. de transacci&oacute;n ${opts.txId}</p>
    <p>Fecha de la transacci&oacute;n ${opts.date}</p>
    <p>Importe del pago ${opts.amountFormatted}</p>
    ${localLine}
    <p>Pago al destinatario ${opts.amountFormatted}</p>
  `);
}

// ══════════════════════════════════════════════════════════════════════════════
// Group 1 — Direct payment receipts (Template A)
// ══════════════════════════════════════════════════════════════════════════════

describe("paypalParser — direct payment receipts (Template A)", () => {
  it("parses COP receipt with period-thousands-separated amount", () => {
    const html = buildDirectPaymentHtml({
      merchant: "Microsoft Corporatio...",
      amountFormatted: "$29.900 COP",
      txId: "4SB16180M7845763K",
      date: "20/03/2026",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("Microsoft Corporatio...");
    expect(r.data.amountCents).toBe(BigInt(2990000));
    expect(r.data.currency).toBe("COP");
    expect(r.data.referenceId).toBe("4SB16180M7845763K");
    // Date 20/03/2026 → UTC midnight
    expect(r.data.occurredAt).toEqual(new Date("2026-03-20T00:00:00Z"));
  });

  it("parses COP receipt with multi-period large amount", () => {
    const html = buildDirectPaymentHtml({
      merchant: "TIENDA ONLINE",
      amountFormatted: "$1.200.000 COP",
      txId: "TXID1234567890ABC",
      date: "15/01/2026",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.amountCents).toBe(BigInt(120000000));
    expect(r.data.currency).toBe("COP");
  });

  it("parses COP receipt dated December 2025 (full year present — no boundary risk)", () => {
    const html = buildDirectPaymentHtml({
      merchant: "Microsoft Corporatio...",
      amountFormatted: "$29.900 COP",
      txId: "1DX51410WE163570S",
      date: "20/12/2025",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.occurredAt).toEqual(new Date("2025-12-20T00:00:00Z"));
  });

  it("returns needs_review for EUR receipt (unsupported currency)", () => {
    const html = buildDirectPaymentHtml({
      merchant: "TS3MusicBot",
      amountFormatted: "€2,50 EUR",
      txId: "1UD557224S834890C",
      date: "5/10/2025",
    });
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("unsupported_currency");
  });

  // USD Template A — not yet observed in prod; exercise the amount-parsing paths.

  it("parses USD Template A with comma-decimal amount (Spanish-locale, validated assumption)", () => {
    const html = buildDirectPaymentHtml({
      merchant: "SomeMerchant",
      amountFormatted: "$6,99 USD",
      txId: "USDA1234567890ABC",
      date: "15/04/2026",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.amountCents).toBe(BigInt(699));
    expect(r.data.currency).toBe("USD");
    expect(r.data.merchant).toBe("SomeMerchant");
    expect(r.data.occurredAt).toEqual(new Date("2026-04-15T00:00:00Z"));
  });

  it("parses USD Template A with whole-dollar amount (no cents)", () => {
    const html = buildDirectPaymentHtml({
      merchant: "SomeMerchant",
      amountFormatted: "$10 USD",
      txId: "USDA0000000010001",
      date: "01/06/2026",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.amountCents).toBe(BigInt(1000));
    expect(r.data.currency).toBe("USD");
  });

  it("returns needs_review for USD Template A with period-decimal amount (unverified US-locale format)", () => {
    // Period-decimal USD in Template A has zero prod samples. We intentionally
    // surface it as needs_review so it can never silently miscalculate cents.
    const html = buildDirectPaymentHtml({
      merchant: "SomeMerchant",
      amountFormatted: "$6.99 USD",
      txId: "USDA9999999999999",
      date: "15/04/2026",
    });
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("unverified_usd_template_a_decimal");
  });

  it("uses opts.receivedAt when body date is missing (Template A)", () => {
    // Strip the date line from a valid COP receipt
    const bodyWithoutDate = wrapPayPal(`
      <p>Recibo de su pago a TIENDA TEST</p>
      <p>Hola, Test User: Ha pagado $50.000 COP a TIENDA TEST Ver o administrar pago</p>
      <p>Id. de transacci&oacute;n TXID123456789ABCD</p>
      <p>Comercio TIENDA TEST billing@test.com</p>
    `);
    const receivedAt = new Date("2026-04-20T14:30:00Z");
    const r = paypalParser.parse(bodyWithoutDate, { receivedAt });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.occurredAt).toEqual(receivedAt);
    expect(r.data.amountCents).toBe(BigInt(5000000));
  });

  it("returns needs_review when body date AND opts.receivedAt are both absent (Template A)", () => {
    const bodyWithoutDate = wrapPayPal(`
      <p>Hola, Test User: Ha pagado $50.000 COP a TIENDA TEST Ver o administrar pago</p>
      <p>Id. de transacci&oacute;n TXID123456789ABCD</p>
    `);
    const r = paypalParser.parse(bodyWithoutDate);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("missing_occurred_at");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 2 — Recurring/automatic payment receipts (Template B)
// ══════════════════════════════════════════════════════════════════════════════

describe("paypalParser — automatic payment receipts (Template B)", () => {
  it("parses USD auto-payment with COP local equivalent", () => {
    const html = buildAutoPaymentHtml({
      merchant: "PremiumSoft CyberTech Ltd.",
      amountFormatted: "$ 6,99 USD",
      currency: "USD",
      txId: "0B66726081324823W",
      date: "11 de junio de 2025",
      localEquivalent: "$ 30.885 COP",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("PremiumSoft CyberTech Ltd.");
    expect(r.data.amountCents).toBe(BigInt(699));
    expect(r.data.currency).toBe("USD");
    expect(r.data.referenceId).toBe("0B66726081324823W");
    // 11 de junio de 2025 → UTC midnight
    expect(r.data.occurredAt).toEqual(new Date("2025-06-11T00:00:00Z"));
  });

  it("parses USD auto-payment in May 2025", () => {
    const html = buildAutoPaymentHtml({
      merchant: "PremiumSoft CyberTech Ltd.",
      amountFormatted: "$ 6,99 USD",
      currency: "USD",
      txId: "5Y269059HY672664M",
      date: "6 de mayo de 2025",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.amountCents).toBe(BigInt(699));
    expect(r.data.currency).toBe("USD");
    expect(r.data.occurredAt).toEqual(new Date("2025-05-06T00:00:00Z"));
  });

  it("parses USD auto-payment with whole-dollar amount (no cents)", () => {
    const html = buildAutoPaymentHtml({
      merchant: "Some Service",
      amountFormatted: "$ 10 USD",
      currency: "USD",
      txId: "TXABC123DEF456GHI",
      date: "1 de enero de 2026",
    });
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.amountCents).toBe(BigInt(1000));
    expect(r.data.currency).toBe("USD");
    expect(r.data.occurredAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("extracts merchant via primary lookahead regex when trailing sentence starts with 'Estos'", () => {
    // The primary merchant regex uses (?=\.\s+(?:Estos|...)) as the lookahead —
    // the period before the trailing sentence IS the lookahead anchor and is NOT
    // captured, so the merchant name comes out without the trailing period.
    // buildAutoPaymentHtml uses "Acerca de su pago" which falls through to the
    // fallback regex. This fixture uses "Estos son los detalles" to exercise the
    // primary lookahead path explicitly.
    const html = wrapPayPal(`
      <p>Envi&oacute; un pago autom&aacute;tico a PremiumSoft CyberTech Ltd.</p>
      <p>Test User, aqu&iacute; tiene su recibo.</p>
      <p>Hola, Test User: Gracias por su pago a PremiumSoft CyberTech Ltd. Estos son los detalles.</p>
      <p>Id. de transacci&oacute;n 0B66726081324823W</p>
      <p>Fecha de la transacci&oacute;n 11 de junio de 2025</p>
      <p>Importe del pago $ 6,99 USD</p>
    `);
    const r = paypalParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    // Lookahead stops before the "." — merchant is captured without trailing period
    expect(r.data.merchant).toBe("PremiumSoft CyberTech Ltd");
    expect(r.data.amountCents).toBe(BigInt(699));
  });

  it("uses opts.receivedAt when body date is missing (Template B)", () => {
    const bodyWithoutDate = wrapPayPal(`
      <p>Envi&oacute; un pago autom&aacute;tico a Some Service</p>
      <p>Hola, Test User: Gracias por su pago a Some Service. Acerca de su pago</p>
      <p>Id. de transacci&oacute;n TXIDABC123DEF456G</p>
      <p>Importe del pago $ 9,99 USD</p>
    `);
    const receivedAt = new Date("2026-03-15T10:00:00Z");
    const r = paypalParser.parse(bodyWithoutDate, { receivedAt });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.occurredAt).toEqual(receivedAt);
    expect(r.data.amountCents).toBe(BigInt(999));
  });

  it("returns needs_review when body date AND opts.receivedAt are both absent (Template B)", () => {
    const bodyWithoutDate = wrapPayPal(`
      <p>Envi&oacute; un pago autom&aacute;tico a Some Service</p>
      <p>Hola, Test User: Gracias por su pago a Some Service. Acerca de su pago</p>
      <p>Id. de transacci&oacute;n TXIDABC123DEF456G</p>
      <p>Importe del pago $ 9,99 USD</p>
    `);
    const r = paypalParser.parse(bodyWithoutDate);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("missing_occurred_at");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 3 — Non-receipt emails (skipped)
// ══════════════════════════════════════════════════════════════════════════════

describe("paypalParser — non-receipt emails (skipped)", () => {
  it("skips policy update / legal notice email", () => {
    const html = wrapPayPal(`
      <p>Estamos realizando algunos cambios en los acuerdos legales de PayPal</p>
      <p>Test User, puede ver los cambios en nuestro sitio web.</p>
      <p>Hola Test User, Estamos haciendo algunos cambios a los acuerdos legales que ser&aacute;n de su inter&eacute;s.</p>
      <p>No se requiere acci&oacute;n hoy, pero si desea obtener m&aacute;s informaci&oacute;n...</p>
    `);
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("non_receipt");
  });

  it("skips auto-pay cancellation notice", () => {
    const html = wrapPayPal(`
      <p>PremiumSoft CyberTech Ltd. cancel&oacute; los pagos autom&aacute;ticos</p>
      <p>Test User, dejaremos de retirar dinero de su cuenta.</p>
      <p>Hola, Test User, PremiumSoft CyberTech Ltd. cancel&oacute; los pagos autom&aacute;ticos.</p>
      <p>Importe que pagar&aacute; cada vez: $6.99 USD</p>
    `);
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("autopay_cancellation");
  });

  it("skips generic account notice (no payment signals)", () => {
    const html = wrapPayPal(`
      <p>Noticias de PayPal para usted</p>
      <p>Test User, tenemos actualizaciones importantes para su cuenta.</p>
      <p>Su cuenta est&aacute; en buen estado. Gracias por usar PayPal.</p>
    `);
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("non_receipt");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 4 — needs_review (partial / malformed receipts)
// ══════════════════════════════════════════════════════════════════════════════

describe("paypalParser — needs_review (missing fields)", () => {
  it("returns needs_review when merchant cannot be extracted from direct payment", () => {
    // Strips the "Ha pagado $X CUR a MERCHANT Ver" sentence entirely
    const html = wrapPayPal(`
      <p>Hola, Test User: Ha pagado a TIENDA TEST Ver o administrar pago</p>
      <p>Id. de transacci&oacute;n TXID123456789ABCD</p>
      <p>Fecha de la transacci&oacute;n 15/04/2026</p>
    `);
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("merchant_not_found");
  });

  it("returns needs_review when date is missing in direct payment", () => {
    const html = wrapPayPal(`
      <p>Hola, Test User: Ha pagado $50.000 COP a TIENDA TEST Ver o administrar pago</p>
      <p>Id. de transacci&oacute;n TXID123456789ABCD</p>
      <p>Comercio TIENDA TEST billing@test.com</p>
    `);
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("missing_occurred_at");
  });

  it("returns needs_review when date is missing in auto-payment", () => {
    const html = wrapPayPal(`
      <p>Envi&oacute; un pago autom&aacute;tico a SomeService</p>
      <p>Test User, aqu&iacute; tiene su recibo.</p>
      <p>Hola, Test User: Gracias por su pago a SomeService. Estos son los detalles.</p>
      <p>Id. de transacci&oacute;n TXIDABC123DEF456G</p>
      <p>Importe del pago $ 9,99 USD</p>
    `);
    const r = paypalParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("missing_occurred_at");
  });
});
