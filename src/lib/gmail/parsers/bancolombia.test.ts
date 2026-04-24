import { describe, expect, it } from "vitest";
import { extractVisibleText, parseBancolombiaEmail } from "./bancolombia";

// Minimal HTML scaffold that mimics real Bancolombia emails: <style> blocks,
// comments, nested tables, and a marketing footer that reuses phrases like
// "tus gastos" — the test fixtures confirm the email parser does NOT skip on
// those footer phrases (which would drop real transactional emails).
function wrapBancolombiaEmail(transactionalSentence: string): string {
  return `<!DOCTYPE html><html><head>
<style>body { margin: 0; } .footer { font-size: 10px; }</style>
<script>/* tracking pixel */</script>
<!-- Bancolombia Alertas y Notificaciones template -->
<title>Alertas y Notificaciones</title>
</head><body>
<table><tr><td><h1>&iexcl;Listo! Todo sali&oacute; bien con tus movimientos</h1></td></tr>
<tr><td><p>${transactionalSentence}</p></td></tr>
<tr><td class="footer"><p>Controla tu dinero y gestiona tus gastos. Usa D&iacute;a a D&iacute;a en la app Bancolombia.</p>
<p>Esto es un mensaje autom&aacute;tico.</p></td></tr>
</table>
</body></html>`;
}

describe("extractVisibleText", () => {
  it("strips style, script, comments, and tags", () => {
    const html =
      "<html><style>.x{color:red}</style><body><!-- foo --><p>Hello <b>world</b></p><script>alert(1)</script></body></html>";
    expect(extractVisibleText(html)).toBe("Hello world");
  });

  it("decodes HTML entities (named + numeric)", () => {
    const html = "<p>&iexcl;Listo! &amp; d&iacute;a &#161; &#x00e1;</p>";
    // iexcl=¡, iacute=í, #161=¡, #x00e1=á
    const out = extractVisibleText(html);
    expect(out).toContain("í");
    expect(out).toContain("¡");
    expect(out).toContain("á");
    expect(out).toContain("&");
  });

  it("collapses whitespace", () => {
    const html = "<p>A   B\n\n\nC\tD</p>";
    expect(extractVisibleText(html)).toBe("A B C D");
  });

  it("strips script/style tags with whitespace before the closing > (CodeQL js/bad-tag-filter)", () => {
    // HTML spec permits whitespace inside a closing tag. A naive `</script>`
    // regex misses `</script >` and leaves script content in the extracted
    // text — a stored-XSS vector if that text is ever re-rendered.
    const html = "<body><script>alert(1)</script ><style>.x{}</style\t>\nhello</body>";
    const text = extractVisibleText(html);
    expect(text).toBe("hello");
    expect(text).not.toContain("alert");
  });

  it("strips multiline <style> blocks (real Bancolombia scaffold)", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Compraste COP10.000,00 en FOO con tu T.Cred *2575, el 01/04/2026 a las 10:00.",
    );
    const text = extractVisibleText(html);
    expect(text).not.toContain("margin: 0");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Compraste COP10.000,00 en FOO");
  });
});

describe("parseBancolombiaEmail — transactional variants", () => {
  it("parses purchase variant A (T.Cred)", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Compraste COP44.247,00 en MERCADOPAGO COLOMBIA con tu T.Cred *2575, el 08/04/2026 a las 17:38.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "purchase") throw new Error(`expected purchase, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(4424700));
    expect(r.currency).toBe("COP");
    expect(r.merchant).toBe("MERCADOPAGO COLOMBIA");
    expect(r.cardLast4).toBe("2575");
    expect(r.cardKind).toBe("credit");
    expect(r.occurredOn).toBe("2026-04-08");
    expect(r.occurredTime).toBe("17:38");
    expect(r.externalId.startsWith("bcol-email:")).toBe(true);
  });

  it("parses purchase T.Deb (debit card)", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Compraste $92.000,00 en EXITO con tu T.Deb *1234, el 10/04/2026 a las 09:15.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "purchase") throw new Error(`expected purchase, got ${r.kind}`);
    expect(r.cardKind).toBe("debit");
    expect(r.amountCents).toBe(BigInt(9200000));
  });

  it("parses transfer_sent", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Transferiste $30,000 desde tu cuenta *6126 a la cuenta *91218413213 el 11/04/2026 a las 14:31.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "transfer_sent") throw new Error(`expected transfer_sent, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(3000000));
    expect(r.fromLast4).toBe("6126");
    expect(r.toAccount).toBe("91218413213");
    expect(r.isQR).toBe(false);
  });

  it("parses qr_payment", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: ALEJANDRO RAFAEL MARTINEZ MALDONADO pagaste $84,000.00 por codigo QR desde tu cuenta *6126 a la llave 0091766433 el 03/04/2026 a las 14:11.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "qr_payment") throw new Error(`expected qr_payment, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(8400000));
    expect(r.fromLast4).toBe("6126");
    expect(r.toKey).toBe("0091766433");
  });

  it("parses tc_payment", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Pagaste COP250.000,00 en la tarjeta de credito *2575 desde la cuenta *6126, el 05/04/2026 a las 10:00.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "tc_payment") throw new Error(`expected tc_payment, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(25000000));
    expect(r.toCardLast4).toBe("2575");
    expect(r.fromLast4).toBe("6126");
  });

  it("parses transfer_received variant A (conectada a la llave)", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: ALEJANDRO, recibiste una transferencia de MARIA PAZ TORRES por $50,000.00 en tu cuenta *6126 conectada a la llave 3012998429 el 01/04/26 a las 13:49.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "transfer_received")
      throw new Error(`expected transfer_received, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(5000000));
    expect(r.senderName).toBe("MARIA PAZ TORRES");
    expect(r.toLast4).toBe("6126");
    expect(r.occurredOn).toBe("2026-04-01");
  });

  it("parses transfer_received variant B (shortened)", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Recibiste una transferencia por $37,000 de MAURICIO JURADO en tu cuenta **6126, el 04/04/2026 a las 16:22.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "transfer_received")
      throw new Error(`expected transfer_received, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(3700000));
    expect(r.senderName).toBe("MAURICIO JURADO");
  });

  it("parses provider_payment", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Recibiste un pago PROVEEDOR de ACME SAS por COP1.500.000,00 en tu cuenta de Ahorros el 20/03/2026 a las 08:00.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "provider_payment") throw new Error(`expected provider_payment, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(150000000));
    expect(r.senderName).toBe("ACME SAS");
  });

  it("parses provider_payment_sent (PSE with HH:MM:SS)", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Pagaste COP85.000,00 a EPM DESDE TU producto *6126 el 22/03/2026 10:30:45",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "provider_payment_sent") {
      throw new Error(`expected provider_payment_sent, got ${r.kind}`);
    }
    expect(r.amountCents).toBe(BigInt(8500000));
    expect(r.providerName).toBe("EPM");
    expect(r.fromLast4).toBe("6126");
    expect(r.occurredTime).toBe("10:30");
  });

  it("parses atm_withdrawal", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Retiraste COP200.000,00 en PQ_ESTRELLA de tu T.Deb *6126 el 15/03/2026 a las 19:20.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "atm_withdrawal") throw new Error(`expected atm_withdrawal, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(20000000));
    expect(r.atmCode).toBe("PQ_ESTRELLA");
    expect(r.fromLast4).toBe("6126");
  });

  it("parses tc_credit_received", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: JUAN PEREZ hizo un abono por COP500.000,00 a tu tarjeta de credito terminada en *2575, el 10/03/2026 15:20",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "tc_credit_received")
      throw new Error(`expected tc_credit_received, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(50000000));
    expect(r.senderName).toBe("JUAN PEREZ");
    expect(r.toCardLast4).toBe("2575");
  });

  it("parses bre_b_transfer", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: ALEJANDRO, transferiste COP15.000,00 a la llave 3001234567 desde tu cuenta *6126 a PEDRO LOPEZ el 09/04/2026 a las 12:00. Con Bre-b es de una y gratis.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "bre_b_transfer") throw new Error(`expected bre_b_transfer, got ${r.kind}`);
    expect(r.amountCents).toBe(BigInt(1500000));
    expect(r.toKey).toBe("3001234567");
    expect(r.fromLast4).toBe("6126");
    expect(r.recipientName).toBe("PEDRO LOPEZ");
  });
});

describe("parseBancolombiaEmail — skip detection", () => {
  it("skips Toc-toc monthly statement notification", () => {
    const html =
      "<html><body><p>&iexcl;Toc-toc! Lleg&oacute; tu extracto del mes. &iexcl;Ya est&aacute; disponible tu extracto para el producto Tarjeta de Cr&eacute;dito.</p></body></html>";
    const r = parseBancolombiaEmail(html);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("statement_notification");
  });

  it("skips universal pattern: failed transaction", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: tu compra con T.cred *2575 por $92.000,00 no fue exitosa, los datos de tu t.cred estan incorrectos.",
    );
    const r = parseBancolombiaEmail(html);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("failed");
  });

  it("skips universal pattern: personal info updated", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Listo. Actualizaste tu informacion personal en Sucursal Virtual, el 15/04/2026 a las 16:25.",
    );
    const r = parseBancolombiaEmail(html);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("non_transactional");
  });

  it("does NOT skip on marketing footer phrases (email-specific regression)", () => {
    // Body contains a real transactional sentence AND the marketing footer
    // phrase "tus gastos" that the SMS path skips on. Reusing SMS skip
    // patterns here would drop this legitimate purchase.
    const html = wrapBancolombiaEmail(
      "Bancolombia: Compraste COP10.000,00 en RAPPI con tu T.Cred *2575, el 01/04/2026 a las 10:00.",
    );
    const r = parseBancolombiaEmail(html);
    expect(r.kind).toBe("purchase");
  });
});

describe("parseBancolombiaEmail — needs_review", () => {
  it("returns needs_review on completely foreign text", () => {
    const html =
      "<html><body><p>Alertas y Notificaciones. Te informamos de un cambio en la tasa de interes de tu cuenta de ahorros.</p></body></html>";
    const r = parseBancolombiaEmail(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("unknown_pattern");
  });
});

describe("parseBancolombiaEmail — externalId namespacing", () => {
  it("uses bcol-email prefix (disjoint from SMS path)", () => {
    const html = wrapBancolombiaEmail(
      "Bancolombia: Compraste COP10.000,00 en FOO con tu T.Cred *2575, el 01/04/2026 a las 10:00.",
    );
    const r = parseBancolombiaEmail(html);
    if (r.kind !== "purchase") throw new Error(`expected purchase, got ${r.kind}`);
    expect(r.externalId.startsWith("bcol-email:")).toBe(true);
    expect(r.externalId.startsWith("bcol-sms:")).toBe(false);
  });
});
