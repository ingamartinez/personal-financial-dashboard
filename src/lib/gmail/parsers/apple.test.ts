import { describe, expect, it } from "vitest";
import { appleParser } from "./apple";

// Minimal scaffold for Apple Layout A (standard invoice/receipt).
// PII sanitised: card last-4 replaced with XXXX, email kept as public test fixture.
function wrapAppleInvoiceA(date: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style type="text/css">body{margin:0;font-family:Helvetica,Arial,sans-serif;}</style>
</head>
<body>
<table width="660" align="center" cellpadding="0" cellspacing="0">
<tr><td>
  <p>Invoice</p>
  <p>${date}</p>
  ${body}
</td></tr>
</table>
</body>
</html>`;
}

// Apple TV monthly invoice (Layout A) — mirrors apple-14
const APPLE_TV_BODY = `
  <p>Order ID: MKX7GM3GZ0</p>
  <p>Document: 778123287571</p>
  <p>Apple Account: test@example.com</p>
  <p>Apple TV</p>
  <p>Monthly</p>
  <p>Renews 22 May 2026</p>
  <p>$ 29.900</p>
  <p>Inclusive of VAT at 19 %</p>
  <p>$ 4.774</p>
  <p>Billing and Payment</p>
  <p>Test User</p>
  <p>Subtotal $ 25.126</p>
  <p>VAT charged at 19 % $ 4.774</p>
  <p>MasterCard •••• XXXX $ 29.900</p>
`;

// Proton VPN monthly invoice (Layout A) — mirrors apple-19
const PROTON_VPN_BODY = `
  <p>Order ID: MKX7FNTFVV</p>
  <p>Document: 698119556165</p>
  <p>Apple Account: test@example.com</p>
  <p>Proton VPN: Rápida y Segura</p>
  <p>VPN Plus (Monthly)</p>
  <p>Renews 14 May 2026</p>
  <p>Alejandro's iPhone</p>
  <p>$ 24.900</p>
  <p>Inclusive of VAT at 19 %</p>
  <p>$ 3.976</p>
  <p>Subtotal $ 20.924</p>
  <p>VAT charged at 19 % $ 3.976</p>
  <p>Visa •••• XXXX $ 24.900</p>
`;

// iCloud Receipt (uses "Receipt" not "Invoice", no VAT line) — mirrors apple-20
const ICLOUD_RECEIPT = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><style>body{margin:0;}</style></head>
<body>
<table width="660" align="center" cellpadding="0" cellspacing="0">
<tr><td>
  <p>Receipt</p>
  <p>4 April 2026</p>
  <p>Order ID: MKX7DLSW75</p>
  <p>Document: 784115222418</p>
  <p>Apple Account: test@example.com</p>
  <p>iCloud</p>
  <p>iCloud+ with 2 TB (Monthly)</p>
  <p>Renews 4 May 2026</p>
  <p>iPhone</p>
  <p>$ 44.900</p>
  <p>Billing and Payment</p>
  <p>Test User</p>
  <p>Subtotal $ 44.900</p>
  <p>Visa •••• XXXX $ 44.900</p>
</td></tr>
</table>
</body>
</html>`;

// Multi-item invoice (Layout A) — mirrors apple-28 with 2 apps
const MULTI_ITEM_BODY = `
  <p>Order ID: MKX7B8N6Z7</p>
  <p>Document: 678110597585</p>
  <p>Apple Account: test@example.com</p>
  <p>CapCut: edita videos y fotos</p>
  <p>Monthly Subscription (Monthly)</p>
  <p>Renews 23 April 2026</p>
  <p>Alejandro's iPhone</p>
  <p>$ 7.900</p>
  <p>Inclusive of VAT at 19 %</p>
  <p>$ 1.261</p>
  <p>Couple Joy - App de relaciones</p>
  <p>Couple Joy Premium (Monthly)</p>
  <p>Renews 25 April 2026</p>
  <p>Alejandro's iPhone</p>
  <p>$ 14.900</p>
  <p>Inclusive of VAT at 19 %</p>
  <p>$ 2.379</p>
  <p>Subtotal $ 19.160</p>
  <p>VAT charged at 19 % $ 3.640</p>
  <p>MasterCard •••• XXXX $ 22.800</p>
`;

// Alt-invoice layout (Layout B — mirrors apple-15)
const ALT_INVOICE = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><style>body{margin:0;}</style></head>
<body>
<table width="660" align="center" cellpadding="0" cellspacing="0">
<tr><td>
  <p>Invoice</p>
  <p>APPLE ACCOUNT test@example.com</p>
  <p>BILLED TO MasterCard .... XXXX</p>
  <p>Test User</p>
  <p>INVOICE DATE 20 Apr 2026</p>
  <p>ORDER ID MKX7GG8HKQ</p>
  <p>DOCUMENT NO. 808122526150</p>
  <p>App Store Widget Web 26 PRO Version</p>
  <p>In-App Purchase</p>
  <p>Alejandro's iPhone</p>
  <p>Report a Problem</p>
  <p>$ 24.900,00</p>
  <p>Inclusive of VAT at 19% $ 3.975,63</p>
  <p>Subtotal $ 20.924,37</p>
  <p>VAT charged at 19% $ 3.975,63</p>
  <p>TOTAL $ 24.900,00</p>
</td></tr>
</table>
</body>
</html>`;

describe("appleParser — invoice parsing (Layout A)", () => {
  it("parses Apple TV monthly invoice", () => {
    const html = wrapAppleInvoiceA("22 April 2026", APPLE_TV_BODY);
    const r = appleParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("Apple TV");
    expect(r.data.amountCents).toBe(BigInt(2990000)); // 29.900 COP = 2 990 000 cents
    expect(r.data.currency).toBe("COP");
    expect(r.data.referenceId).toBe("MKX7GM3GZ0");
    expect(r.data.occurredAt).toEqual(new Date("2026-04-22T00:00:00Z"));
  });

  it("parses Proton VPN monthly invoice (Visa)", () => {
    const html = wrapAppleInvoiceA("13 April 2026", PROTON_VPN_BODY);
    const r = appleParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toContain("Proton VPN");
    expect(r.data.amountCents).toBe(BigInt(2490000)); // 24.900 COP
    expect(r.data.referenceId).toBe("MKX7FNTFVV");
    expect(r.data.occurredAt).toEqual(new Date("2026-04-13T00:00:00Z"));
  });

  it("parses iCloud Receipt (no VAT, uses Subtotal as fallback)", () => {
    const r = appleParser.parse(ICLOUD_RECEIPT);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.merchant).toBe("iCloud");
    expect(r.data.amountCents).toBe(BigInt(4490000)); // 44.900 COP
    expect(r.data.referenceId).toBe("MKX7DLSW75");
    expect(r.data.occurredAt).toEqual(new Date("2026-04-04T00:00:00Z"));
  });

  it("parses multi-item invoice and takes the total card charge amount", () => {
    const html = wrapAppleInvoiceA("25 March 2026", MULTI_ITEM_BODY);
    const r = appleParser.parse(html);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    // Total charge is 22.800, not per-item amounts
    expect(r.data.amountCents).toBe(BigInt(2280000));
    expect(r.data.referenceId).toBe("MKX7B8N6Z7");
    expect(r.data.occurredAt).toEqual(new Date("2026-03-25T00:00:00Z"));
  });
});

describe("appleParser — alt-invoice Layout B", () => {
  it("parses alt-invoice with ORDER ID (no colon) and INVOICE DATE", () => {
    const r = appleParser.parse(ALT_INVOICE);
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.data.amountCents).toBe(BigInt(2490000)); // 24.900,00 → 24900 COP
    expect(r.data.referenceId).toBe("MKX7GG8HKQ");
    expect(r.data.occurredAt).toEqual(new Date("2026-04-20T00:00:00Z"));
  });
});

describe("appleParser — skip conditions", () => {
  it("skips Recent Purchase (security alert)", () => {
    const html = `<html><body><p>Recent Purchase</p><p>Dear Alejandro, Your Apple Account was just used to make a purchase in SSH Client on a new device.</p></body></html>`;
    const r = appleParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("recent_purchase_alert");
  });

  it("skips Subscription Confirmed (free trial, no charge)", () => {
    const html = `<html><body><p>Subscription Confirmed</p><p>SSH Client - Secure ShellFish</p><p>Trial Free for 2 weeks, starting 23 April 2026</p></body></html>`;
    const r = appleParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("subscription_confirmed_trial");
  });

  it("skips Subscription Expiring", () => {
    const html = `<html><body><p>Subscription Expiring</p><p>Tinder Platinum (1 month) $ 40.500/month expires on 30 April.</p></body></html>`;
    const r = appleParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("subscription_expiring");
  });

  it("skips Developer Agreement notification", () => {
    const html = `<html><body><p>Hello Alejandro, You have signed the following agreement: Apple Developer Agreement</p></body></html>`;
    const r = appleParser.parse(html);
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("developer_agreement");
  });

  it("skips family welcome email (no invoice/billing signals)", () => {
    const html = `<html><body><p>Te damos la bienvenida a En familia, Alejandro!</p><p>Como persona que organiza la familia, puedes invitar hasta a otros cinco miembros.</p></body></html>`;
    const r = appleParser.parse(html);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("unrecognized_apple_email_type");
  });
});

describe("appleParser — needs_review", () => {
  it("returns needs_review for invoice missing Order ID", () => {
    const html = `<html><body>
      <p>Invoice</p>
      <p>22 April 2026</p>
      <p>Apple Account: test@example.com</p>
      <p>Apple TV</p>
      <p>Monthly</p>
      <p>Subtotal $ 29.900</p>
      <p>MasterCard •••• XXXX $ 29.900</p>
    </body></html>`;
    const r = appleParser.parse(html);
    // No Order ID → falls through to unrecognized (no hasOrderId)
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("unrecognized_apple_email_type");
  });
});
