import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseArqEmail } from "./arq";

// ---------------------------------------------------------------------------
// Fixture helpers
//
// All fixtures are REDACTED — no real PII, account numbers, or exact
// counterparty names from prod. They preserve the structural markers the
// parser depends on (title tag, paragraph labels/values, USDc lines, COP lines).
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
    usdcCreditedLine ?? `<p>We&#39;ve credited ${amountUsd} USDc to your balance</p>`;
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
function makeTitledSentEmail(copAmount: string, counterparty: string, usdcDebited: string): string {
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
    <tr><td><p>COP transfer sent</p></td></tr>
    <tr><td><p>Recipient name</p></td></tr>
    <tr><td><p>${counterparty}</p></td></tr>
    <tr><td><p>Amount sent</p></td></tr>
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
    const html = makeReceivedEmail(
      "2,060",
      "CODEBRANCH LLC",
      "We&#39;ve credited 2,060 USDc to your balance",
    );
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
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
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
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
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
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

describe("parseArqEmail — transfer_sent (template 1 — no-title paragraph labels)", () => {
  it("parses no-title sent: Recipient name label followed by its value", () => {
    const html = makeNoTitleSentEmail("REDACTED RECIPIENT", "2,104,000", "563.81");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.txKind).toBe("transfer_sent");
    // USDc: 563.81 × 100 = 56381 cents
    expect(r.amountUsdcCents).toBe(BigInt(56381));
    expect(r.counterpartyName).toBe("REDACTED RECIPIENT");
    // COP: 2,104,000 × 100 = 210400000 cents
    expect(r.copAmountCents).toBe(BigInt(210400000));
    // implied TRM: 210_400_000 / 56_381 ≈ 3731 (realistic for COP/USD)
    expect(r.impliedTrmCopPerUsdc).toBeCloseTo(210400000 / 56381, 0);
  });

  it("uses the recipient value instead of the account owner's greeting", () => {
    const html = readFileSync(
      new URL("./fixtures/arq-transfer-greeting.html", import.meta.url),
      "utf8",
    );
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    expect(r.counterpartyName).toBe("SYNTHETIC RECIPIENT");
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

describe("parseArqEmail — titled COP transfer_sent with &rsquo; in body (issue #641)", () => {
  /**
   * This fixture reproduces the exact template that caused receipt id 1364 to
   * loop indefinitely in prod (2026-04-29). The distinguishing features are:
   *
   *   1. <title>You sent {COP} COP to {name}</title>  — template 2 route
   *   2. Body uses &rsquo; in "We&rsquo;ve debited" — was undecoded before #641
   *   3. A display:none preheader contains the "Hi USER, You&rsquo;ve set up..."
   *      sentence — mimics the real ARQ HTML structure
   *
   * PII redacted: name → "Test Recipient", amounts → synthetic but structurally
   * equivalent. DO NOT commit the real prod HTML at /tmp/arq-1364.html.
   */
  function makeCopTitledSentWithRsquo(
    copAmount: string,
    name: string,
    usdcDebited: string,
  ): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>You sent ${copAmount} COP to ${name}</title>
  <style>body{margin:0;font-family:sans-serif;}</style>
</head>
<body>
  <!-- Preheader: display:none — visible text extractor must strip tags but keep text -->
  <div style="display:none;max-height:0;overflow:hidden;">
    Hi User, You&rsquo;ve set up a transfer to ${name}. We&rsquo;ve debited ${usdcDebited} USDc from your balance.
  </div>
  <table>
    <tr><td><h1>COP transfer sent</h1></td></tr>
    <tr><td><p>Amount sent: ${copAmount} COP</p></td></tr>
    <tr><td><p>We&rsquo;ve debited ${usdcDebited} USDc from your balance.</p></td></tr>
    <tr><td><p>To: ${name}</p></td></tr>
  </table>
</body>
</html>`;
  }

  it("parses titled COP transfer_sent where body uses &rsquo; apostrophe", () => {
    // Before #641 fix: &rsquo; was left literal → DEBITED_RE didn't match →
    // needs_review('no_usdc_amount_titled_sent') → receipt stuck in pending forever.
    const html = makeCopTitledSentWithRsquo("1,234,567", "Test Recipient", "337.05");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.txKind).toBe("transfer_sent");
    // USDc debited: 337.05 × 100 = 33705 cents
    expect(r.amountUsdcCents).toBe(BigInt(33705));
    expect(r.counterpartyName).toBe("Test Recipient");
    // COP amount: 1,234,567 × 100 = 123456700 cents
    expect(r.copAmountCents).toBe(BigInt(123456700));
    // implied TRM: 123_456_700 / 33_705 ≈ 3663 COP/USDc (realistic)
    expect(r.impliedTrmCopPerUsdc).toBeCloseTo(123456700 / 33705, 0);
  });

  it("preheader &rsquo; lines do not confuse amount extraction (two debited lines)", () => {
    // Same template but confirms that when the preheader and main body both say
    // "We've debited X USDc", the parser finds the correct amount (they agree).
    const html = makeCopTitledSentWithRsquo("500,000", "Test Recipient", "136.58");
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    // 136.58 × 100 = 13658 cents
    expect(r.amountUsdcCents).toBe(BigInt(13658));
    expect(r.copAmountCents).toBe(BigInt(50000000));
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

describe("parseArqEmail — transfer_received (COP payment received, issue #1015)", () => {
  // Real prod receipts 2485 (25 Oct 2026) and 2409 (2 Oct 2026) of user 1 fell
  // through to needs_review('unknown_arq_template'): the template has no <title>
  // and says "$X USDc has been added to your balance", which the title-driven
  // received parser never saw. Both receipts are real income missing from ARQ.
  const COP_PAYMENT_RECEIVED_FIXTURE = () =>
    readFileSync(new URL("./fixtures/arq-cop-payment-received.html", import.meta.url), "utf8");

  it("parses the redacted real template: USDc added to balance, sender, COP leg and implied TRM", () => {
    const r = parseArqEmail(COP_PAYMENT_RECEIVED_FIXTURE(), { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.txKind).toBe("transfer_received");
    // "$412.50 USDc has been added to your balance" → 41250 cents
    expect(r.amountUsdcCents).toBe(BigInt(41250));
    expect(r.counterpartyName).toBe("Test Sender");
    expect(r.occurredAt).toEqual(RECEIVED_AT);
    // "Amount Received 1,250,000 COP" → 125000000 cents
    expect(r.copAmountCents).toBe(BigInt(125000000));
    // implied TRM: 125_000_000 / 41_250 ≈ 3030.3 COP per USDc
    expect(r.impliedTrmCopPerUsdc).toBeCloseTo(125000000 / 41250, 1);
  });

  it("takes the sender from the From detail label, not from the greeting", () => {
    // Regression guard for #921's class of bug: the greeting says "Hi Test User,"
    // and the money came from "Test Sender". The label wins.
    const r = parseArqEmail(COP_PAYMENT_RECEIVED_FIXTURE(), { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed") throw new Error(`expected parsed, got ${r.kind}`);
    expect(r.counterpartyName).toBe("Test Sender");
    expect(r.counterpartyName).not.toBe("Test User");
  });

  it("falls back to the prose sentence when the detail labels are absent", () => {
    const html = `<!DOCTYPE html><html><head><style>body{}</style></head>
<body>
  <h1>COP payment received</h1>
  <p>Hello Test User, You have received 1,250,000 COP from Test Sender. $412.50 USDc has been added to your balance.</p>
</body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    if (r.kind !== "parsed")
      throw new Error(`expected parsed, got ${r.kind}: ${JSON.stringify(r)}`);
    expect(r.amountUsdcCents).toBe(BigInt(41250));
    expect(r.counterpartyName).toBe("Test Sender");
    expect(r.copAmountCents).toBe(BigInt(125000000));
  });

  it("returns needs_review when no USDc added-to-balance amount can be found", () => {
    const html = `<!DOCTYPE html><html><head><style>body{}</style></head>
<body><h1>COP payment received</h1><p>From</p><p>Test Sender</p></body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("no_usdc_added_amount");
  });

  it("returns needs_review when the balance amount is not USDc", () => {
    const html = `<!DOCTYPE html><html><head><style>body{}</style></head>
<body>
  <h1>COP payment received</h1>
  <p>From</p><p>Test Sender</p>
  <p>Amount Added to Balance</p><p>$412.50 USDT</p>
</body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("invalid_usdc_added_amount");
  });

  it("returns needs_review when the From label has no value of its own", () => {
    // An empty/absent value must not fall through to the next label as if it
    // were a name — that is how the greeting bug came back the first time.
    const html = `<!DOCTYPE html><html><head><style>body{}</style></head>
<body>
  <h1>COP payment received</h1>
  <p>From</p>
  <p>Amount Received</p><p>1,250,000 COP</p>
  <p>Amount Added to Balance</p><p>$412.50 USDc</p>
</body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("no_sender_name");
  });

  it("does not treat marketing mail that mentions the marker in CSS as a transfer", () => {
    const html = `<html><head>
  <style>.hero::before { content: "COP payment received"; }</style>
  <title>New features are here</title>
</head><body><p>Discover what is new in the ARQ app this month.</p></body></html>`;
    const r = parseArqEmail(html, { occurredAt: RECEIVED_AT });
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") expect(r.reason).toBe("unknown_arq_template");
  });
});
