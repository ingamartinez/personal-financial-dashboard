import { describe, expect, it } from "vitest";
import { parseArqEmail } from "./arq";

// ---------------------------------------------------------------------------
// Fixture helpers
//
// All fixtures are REDACTED — no real PII, account numbers, or exact
// counterparty names from prod. They preserve the structural markers the
// parser depends on (title tag, h1/h2 ladder, USDc lines, COP lines).
// ---------------------------------------------------------------------------

const RECEIVED_AT = new Date("2026-04-13T21:40:00Z");

/**
 * Build a minimal ARQ email with <title>You received {amount} USD from {name}</title>.
 * Template 3 — the salary / inbound USD transfer variant.
 */
function makeReceivedEmail(
  amountUsd: string,
  counterparty: string,
  usdcCreditedLine?: string,
): string {
  const creditedLine =
    usdcCreditedLine ??
    `<p>We&#39;ve credited ${amountUsd} USDc to your balance</p>`;
  return `<!DOCTYPE html><html>
<head>
  <meta charset="UTF-8">
  <title>You received ${amountUsd} USD from ${counterparty}</title>
  <style>body{margin:0;font-family:sans-serif;}</style>
</head>
<body>
  <table>
    <tr><td><h1>Money received!</h1></td></tr>
    <tr><td><p>You received <strong>${amountUsd} USD</strong> from <strong>${counterparty}</strong>.</p></td></tr>
    <tr><td>${creditedLine}</td></tr>
    <tr><td><p>Thank you for using ARQ (formerly DolarApp).</p></td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build a minimal ARQ email with <title>You sent {amount} COP to {name}</title>.
 * Template 2 — the titled transfer_sent variant.
 */
function makeTitledSentEmail(
  copAmount: string,
  counterparty: string,
  usdcDebited: string,
): string {
  return `<!DOCTYPE html><html>
<head>
  <meta charset="UTF-8">
  <title>You sent ${copAmount} COP to ${counterparty}</title>
  <style>body{margin:0;}</style>
</head>
<body>
  <table>
    <tr><td><h1>Transfer complete</h1></td></tr>
    <tr><td><p>Amount sent: ${copAmount} COP</p></td></tr>
    <tr><td><p>We&#39;ve debited ${usdcDebited} USDc from your balance</p></td></tr>
    <tr><td><p>To: ${counterparty}</p></td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build a minimal ARQ "no-title" COP transfer sent email.
 * Template 1 — the dominant variant (47% of real corpus, h1/h2 ladder).
 */
function makeNoTitleSentEmail(
  counterparty: string,
  copAmount: string,
  usdcDebited: string,
): string {
  return `<!DOCTYPE html><html>
<head>
  <meta charset="UTF-8">
  <!-- No <title> tag — this is the identifying marker for template 1 -->
  <style>body{margin:0;}</style>
</head>
<body>
  <table>
    <tr><td><h1>COP transfer sent</h1></td></tr>
    <tr><td><h2>${counterparty}</h2></td></tr>
    <tr><td><h3>Amount sent</h3></td></tr>
    <tr><td><p>${copAmount} COP</p></td></tr>
    <tr><td><p>We&#39;ve debited ${usdcDebited} USDc from your balance</p></td></tr>
    <tr><td><p>Amount sent: ${copAmount} COP</p></td></tr>
    <tr><td><p>Your ARQ balance has been updated.</p></td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build a non-transactional statement notification email.
 */
function makeStatementEmail(): string {
  return `<!DOCTYPE html><html>
<head><title>Your account statement is available</title></head>
<body><p>Your account statement is available. Download it from the app.</p></body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseArqEmail — transfer_received (template 3)", () => {
  it("parses the salary sample: 2,060 USD from CODEBRANCH LLC (body has credited line)", () => {
    // Mirrors the real prod email id=800 (CODEBRANCH LLC salary, 2026-04-13).
    // Amount, counterparty, and structure are real; display name is redacted.
    const html = makeReceivedEmail("2,060", "CODEBRANCH LLC", "We&#39;ve credited 2,060 USDc to your balance");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.txKind).toBe("transfer_received");
    // 2,060 USD × 100 = 206000 cents
    expect(r.amountUsdcCents).toBe(BigInt(206000));
    expect(r.counterpartyName).toBe("CODEBRANCH LLC");
    expect(r.occurredAt).toEqual(RECEIVED_AT);
    expect(r.copAmountCents).toBeNull();
    expect(r.impliedTrmCopPerUsdc).toBeNull();
  });

  it("falls back to title amount when body has no credited line", () => {
    // Some templates omit the "We've credited" body line — the title is enough.
    const html = makeReceivedEmail("500", "ACME CORP", "");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.txKind).toBe("transfer_received");
    // 500 USD × 100 = 50000 cents
    expect(r.amountUsdcCents).toBe(BigInt(50000));
    expect(r.counterpartyName).toBe("ACME CORP");
  });

  it("parses fractional USD amounts (e.g. 337.05 from yield)", () => {
    const html = makeReceivedEmail(
      "337.05",
      "ARQ Yield",
      "We&#39;ve credited 337.05 USDc to your balance",
    );
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    // 337.05 × 100 = 33705 cents
    expect(r.amountUsdcCents).toBe(BigInt(33705));
    expect(r.counterpartyName).toBe("ARQ Yield");
  });

  it("returns needs_review when title amount is zero", () => {
    const html = makeReceivedEmail("0", "SOMEONE", "We&#39;ve credited 0 USDc to your balance");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
  });
});

describe("parseArqEmail — transfer_sent (template 2 — titled)", () => {
  it("parses titled sent: 1,200,000 COP with 337.05 USDc debited", () => {
    // Mirrors real prod email id=815 (COP transfer to recipient).
    const html = makeTitledSentEmail("1,200,000", "REDACTED RECIPIENT", "337.05");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.txKind).toBe("transfer_sent");
    // USDc debited: 337.05 × 100 = 33705 cents
    expect(r.amountUsdcCents).toBe(BigInt(33705));
    expect(r.counterpartyName).toBe("REDACTED RECIPIENT");
    // COP amount: 1,200,000 × 100 = 120000000 cents
    expect(r.copAmountCents).toBe(BigInt(120000000));
    // implied TRM: 120_000_000 / 33_705 ≈ 3560.9 (COP per USDc)
    expect(r.impliedTrmCopPerUsdc).toBeCloseTo(120000000 / 33705, 1);
  });

  it("parses titled sent with counterparty name including spaces", () => {
    const html = makeTitledSentEmail("500,000", "Maria Eugenia Giraldo", "140.28");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    expect(r.txKind).toBe("transfer_sent");
    expect(r.counterpartyName).toBe("Maria Eugenia Giraldo");
    expect(r.copAmountCents).toBe(BigInt(50000000));
  });
});

describe("parseArqEmail — transfer_sent (template 1 — no-title h1/h2 ladder)", () => {
  it("parses no-title sent: h1=COP transfer sent + h2=RecipientName", () => {
    const html = makeNoTitleSentEmail("REDACTED RECIPIENT", "2,104,000", "563.81");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.txKind).toBe("transfer_sent");
    // USDc: 563.81 × 100 = 56381 cents
    expect(r.amountUsdcCents).toBe(BigInt(56381));
    expect(r.counterpartyName).toBe("REDACTED RECIPIENT");
    // COP: 2,104,000 × 100 = 210400000 cents
    expect(r.copAmountCents).toBe(BigInt(210400000));
    // implied TRM: 210_400_000 / 56_381 ≈ 3731 (realistic for COP/USD)
    expect(r.impliedTrmCopPerUsdc).toBeCloseTo(210400000 / 56381, 0);
  });

  it("returns needs_review when USDc debited line is missing in no-title template", () => {
    const html = `<!DOCTYPE html><html>
<head><style>body{}</style></head>
<body>
  <h1>COP transfer sent</h1>
  <h2>Some Recipient</h2>
  <p>Amount sent: 1,000,000 COP</p>
  <!-- No "We've debited" line — can't determine USDc amount -->
</body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") {
      expect(r.reason).toBe("no_usdc_debited_amount");
    }
  });
});

describe("parseArqEmail — skip patterns", () => {
  it("skips statement notification emails", () => {
    const html = makeStatementEmail();
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") {
      expect(r.reason).toBe("statement_notification");
    }
  });

  it("skips marketing/rebrand emails", () => {
    const html = `<html><body><p>Meet our new brand: ARQ — the future of money.</p></body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") {
      expect(r.reason).toBe("marketing");
    }
  });

  it("skips plan cancelled notification", () => {
    const html = `<html><head><title>Your Monthly plan has been cancelled</title></head>
<body><p>Your Monthly plan has been cancelled. You can re-subscribe anytime.</p></body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("skip");
  });
});

describe("parseArqEmail — unknown templates", () => {
  it("returns needs_review for unrecognised email bodies", () => {
    const html = `<html><head><title>Crypto top-ups with USDc and USDT</title></head>
<body><p>You topped up your account with USDc. Details inside.</p></body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") {
      expect(r.reason).toBe("unknown_arq_template");
    }
  });

  it("returns needs_review for completely empty body", () => {
    const html = `<html><head></head><body></body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
  });
});

describe("parseArqEmail — amount edge cases", () => {
  it("handles large COP amounts with millions separator correctly", () => {
    // "4,000,000" COP → 400000000 cents
    const html = makeTitledSentEmail("4,000,000", "SOMEONE", "1,070.00");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    expect(r.copAmountCents).toBe(BigInt(400000000));
    expect(r.amountUsdcCents).toBe(BigInt(107000));
  });

  it("strips styles from email before matching (no false positives from CSS)", () => {
    // CSS could contain text like 'content: "COP transfer sent"' which the parser
    // must not pick up as a template 1 marker.
    const html = `<html>
<head>
  <style>
    .label::before { content: "COP transfer sent"; }
    body { background: white; }
  </style>
  <title>You received 100 USD from TEST</title>
</head>
<body>
  <p>We've credited 100 USDc to your balance</p>
</body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    // Should parse as transfer_received (title), not trigger no-title path from CSS text.
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    expect(r.txKind).toBe("transfer_received");
    expect(r.amountUsdcCents).toBe(BigInt(10000));
    expect(r.counterpartyName).toBe("TEST");
  });
});

describe("parseArqEmail — FROM display name tolerance", () => {
  it("parses emails regardless of display name format in From header (parser ignores From)", () => {
    // The FROM header 'ARQ (formerly DolarApp) <no-reply@arqfinance.com>' is
    // handled at the registry/pull layer — the parser only sees the HTML body.
    // This test confirms the parser works correctly independent of From metadata.
    const html = makeReceivedEmail("2,060", "CODEBRANCH LLC");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    expect(r.txKind).toBe("transfer_received");
  });
});
