import { extractVisibleText } from "./_text";

// ---------------------------------------------------------------------------
// ARQ (formerly DolarApp) Gmail parser — #508 (Epic ARQ #512)
//
// ARQ sends transactional emails from @arqfinance.com (current) and
// @dolarapp.com (legacy). Three template variants are handled here:
//
//   1. "no-title" transfer_sent: a "Recipient name" paragraph followed by
//      its value, body contains "We've debited X.XX USDc from your balance" and
//      "Amount sent: 1,234,567 COP". No <title> tag or empty title.
//
//   2. "titled" transfer_sent: <title>You sent {amount} COP to {name}</title>
//      Same body structure as template 1.
//
//   3. transfer_received: <title>You received {amount} USD from {name}</title>
//      Body contains "We've credited X.XX USDc to your balance".
//      Covers salary (CODEBRANCH LLC) and other inbound USD transfers.
//
//   4. "COP payment received" transfer_received (#1015): no <title>; an
//      <h1> reads "COP payment received" and the body says "You have received
//      N COP from {name}. $M USDc has been added to your balance." Detail
//      labels (From / Amount Received / Amount Added to Balance / Date) follow.
//      Incoming COP payments converted to USDc — real income that the
//      title-driven received path never saw.
//
// Design decisions (ratified in issue #508 body, 2026-04-26):
//   - ARQ Ahorros is USD-pure. USDc ≡ USD 1:1 in this account.
//   - metadata.fx is always written, even for trivial USD↔USDc cases
//     (trmSource: '1_to_1') so #519 can process them uniformly.
//   - metadata.arq.recipient_name is persisted for cross-channel pairing (#518).
//   - No A+ dedup vs statement in this parser — that is #517's job.
// ---------------------------------------------------------------------------

export type ArqTransferKind = "transfer_received" | "transfer_sent";

export interface ParsedArqTx {
  txKind: ArqTransferKind;
  // Amount in USDc cents (the ARQ ledger currency). Always positive bigint.
  // transfer_sent: amount debited from ARQ wallet in USDc.
  // transfer_received: amount credited to ARQ wallet in USDc.
  amountUsdcCents: bigint;
  // Counterparty name — sender for received, recipient for sent.
  counterpartyName: string;
  // ISO-8601 date+time from email received-at metadata (set by caller).
  occurredAt: Date;
  // For transfer_sent: the COP amount sent to the recipient (from email body).
  // Null if the template doesn't expose it.
  copAmountCents: bigint | null;
  // For transfer_sent: TRM implied by the email (COP per USDc).
  // Null when we have no COP amount to compute it from.
  impliedTrmCopPerUsdc: number | null;
}

export type ArqParseResult =
  | ({ kind: "parsed" } & ParsedArqTx)
  | { kind: "skip"; reason: string; raw: string }
  | { kind: "needs_review"; reason: string; raw: string };

// ---------------------------------------------------------------------------
// Skip patterns for non-transactional ARQ emails
// ---------------------------------------------------------------------------

const SKIP_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Monthly statement notification — non-transactional; the statement PDF/CSV
  // itself is processed separately by #502/#513.
  { pattern: /your\s+account\s+statement\s+is\s+available/i, reason: "statement_notification" },
  // Plan lifecycle — non-transactional.
  {
    pattern: /your\s+(?:monthly|premium)\s+plan\s+has\s+been\s+cancelled/i,
    reason: "plan_cancelled",
  },
  { pattern: /your\s+premium\s+rewards\s+are\s+changing/i, reason: "marketing" },
  // Rebrand announcement — pure marketing.
  { pattern: /meet\s+our\s+new\s+brand\s*:\s*arq/i, reason: "marketing" },
];

// ---------------------------------------------------------------------------
// Amount parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a human-formatted amount like "2,060" or "1,234,567.89" or "337.05"
 * into bigint cents. Assumes comma is thousands separator, period is decimal.
 * Returns null on parse failure.
 */
function parseAmountToCents(raw: string): bigint | null {
  // Strip commas (thousands separators) — ARQ uses "2,060" not "2.060".
  const normalized = raw.replace(/,/g, "").trim();
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  // Round to avoid floating-point noise (e.g. 337.05 * 100 = 33704.999...).
  return BigInt(Math.round(n * 100));
}

// ---------------------------------------------------------------------------
// Template detection helpers
// ---------------------------------------------------------------------------

/**
 * Extract raw <title> text from HTML before full text extraction.
 * Returns null if absent or empty.
 */
function extractRawTitle(rawHtml: string): string | null {
  const m = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title[^>]*>/i);
  if (!m) return null;
  const t = m[1].trim();
  return t.length > 0 ? t : null;
}

/**
 * Extract visible paragraph text in document order. The no-title ARQ template
 * renders detail labels and values as adjacent paragraphs.
 */
function extractParagraphTexts(rawHtml: string): string[] {
  const paragraphs: string[] = [];
  for (const match of rawHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const text = extractVisibleText(match[1]);
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Titled variants (from <title> tag).
// "You sent 1,200,000 COP to Maria Eugenia Giraldo"
// "You received 2,060 USD from CODEBRANCH LLC"
const TITLED_SENT_RE = /^You\s+sent\s+([\d,]+(?:\.\d+)?)\s+(COP|USD|USDc)\s+to\s+(.+)$/i;
const TITLED_RECEIVED_RE = /^You\s+received\s+([\d,]+(?:\.\d+)?)\s+(COP|USD|USDc)\s+from\s+(.+)$/i;

// Body patterns present in all transfer emails.
const DEBITED_RE = /[Ww]e['’]ve\s+debited\s+([\d,]+(?:\.\d+)?)\s+USDc\s+from\s+your\s+balance/i;
const CREDITED_RE = /[Ww]e['’]ve\s+credited\s+([\d,]+(?:\.\d+)?)\s+USDc\s+to\s+your\s+balance/i;

// COP amount in transfer_sent emails.
const AMOUNT_SENT_RE = /Amount\s+sent\s*:\s*([\d,]+(?:\.\d+)?)\s+(COP|USD|USDc)/i;

// Marker for template 1 (no-title sent).
const NO_TITLE_SENT_MARKER = /COP\s+transfer\s+sent/i;

// --- Template 4: "COP payment received" (#1015) --------------------------

// No <title>; the identifying marker is the <h1> section heading.
const COP_PAYMENT_RECEIVED_MARKER = /COP\s+payment\s+received/i;

// Prose sentence of the same template, used as a fallback when the detail
// labels are absent:
//   "You have received 1,250,000 COP from Test Sender. $412.50 USDc has been
//    added to your balance."
const COP_RECEIVED_SENTENCE_RE =
  /You\s+have\s+received\s+([\d,]+(?:\.\d+)?)\s+COP\s+from\s+([^.$]+?)\s*[.$]/i;
const USD_ADDED_TO_BALANCE_RE =
  /\$\s*([\d,]+(?:\.\d+)?)\s+USDc\s+has\s+been\s+added\s+to\s+your\s+balance/i;

// Detail labels, rendered as adjacent <p> elements (label, then value).
const LABEL_FROM_RE = /^From$/i;
const LABEL_AMOUNT_RECEIVED_RE = /^Amount\s+Received$/i;
const LABEL_AMOUNT_ADDED_RE = /^Amount\s+Added\s+to\s+Balance$/i;
const ARQ_DETAIL_LABEL_RES: ReadonlyArray<RegExp> = [
  LABEL_FROM_RE,
  LABEL_AMOUNT_RECEIVED_RE,
  LABEL_AMOUNT_ADDED_RE,
  /^Date$/i,
];

// Detail values. The balance leg is the authoritative ledger amount and must be
// USDc — anything else is a template change we refuse to guess about.
const USDC_DETAIL_VALUE_RE = /^\$?\s*([\d,]+(?:\.\d+)?)\s+USDc$/i;
const COP_DETAIL_VALUE_RE = /^([\d,]+(?:\.\d+)?)\s+COP$/i;

// ---------------------------------------------------------------------------
// Per-template parsers
// ---------------------------------------------------------------------------

/**
 * Parse template 1 — the "no-title" COP transfer sent variant.
 *
 * Expected visible-text structure:
 *   "... COP transfer sent ... Recipient name [RecipientName]
 *    Amount sent ... [copAmount] COP We've debited [usdcAmount] USDc ..."
 *
 * Recipient name is taken from the paragraph immediately following the
 * `Recipient name` label.
 */
function parseNoTitleSent(visibleText: string, rawHtml: string, occurredAt: Date): ArqParseResult {
  // USDc debited is the authoritative ledger amount.
  const debitedMatch = visibleText.match(DEBITED_RE);
  if (!debitedMatch) {
    return { kind: "needs_review", reason: "no_usdc_debited_amount", raw: visibleText };
  }
  const amountUsdcCents = parseAmountToCents(debitedMatch[1]);
  if (amountUsdcCents === null || amountUsdcCents <= BigInt(0)) {
    return { kind: "needs_review", reason: "invalid_usdc_amount", raw: visibleText };
  }

  // Real ARQ emails render the detail labels and values as adjacent paragraphs:
  // "Recipient name", then the actual recipient. This avoids depending on the
  // greeting's language or markup (which varies between templates).
  const paragraphs = extractParagraphTexts(rawHtml);
  const recipientLabelIndex = paragraphs.findIndex((paragraph) =>
    /^Recipient\s+name$/i.test(paragraph),
  );
  const labeledRecipient =
    recipientLabelIndex >= 0 ? paragraphs[recipientLabelIndex + 1] : undefined;

  // Fail closed when the known detail structure is absent. Falling back to
  // text after the template marker would reintroduce the greeting bug.
  if (!labeledRecipient) {
    return { kind: "needs_review", reason: "no_recipient_name", raw: visibleText };
  }
  const counterpartyName = labeledRecipient.replace(/\s+/g, " ").trim();

  if (!counterpartyName) {
    return { kind: "needs_review", reason: "no_recipient_name", raw: visibleText };
  }

  // COP amount — optional.
  const copMatch = visibleText.match(AMOUNT_SENT_RE);
  let copAmountCents: bigint | null = null;
  let impliedTrmCopPerUsdc: number | null = null;
  if (copMatch && copMatch[2].toUpperCase() === "COP") {
    copAmountCents = parseAmountToCents(copMatch[1]);
    if (copAmountCents !== null && amountUsdcCents > BigInt(0)) {
      impliedTrmCopPerUsdc = Number(copAmountCents) / Number(amountUsdcCents);
    }
  }

  const parsed: ParsedArqTx = {
    txKind: "transfer_sent",
    amountUsdcCents,
    counterpartyName,
    occurredAt,
    copAmountCents,
    impliedTrmCopPerUsdc,
  };
  return { kind: "parsed", ...parsed };
}

/**
 * Parse template 2 — titled transfer_sent.
 * <title>You sent {amount} COP to {name}</title>
 */
function parseTitledSent(title: string, visibleText: string, occurredAt: Date): ArqParseResult {
  const m = title.match(TITLED_SENT_RE);
  if (!m) {
    return { kind: "needs_review", reason: "titled_sent_no_match", raw: visibleText };
  }
  const titleAmountStr = m[1];
  const titleCurrency = m[2].toUpperCase();
  const counterpartyName = m[3].trim().replace(/\s+/g, " ");

  // USDc debited from body is the canonical ledger amount.
  const debitedMatch = visibleText.match(DEBITED_RE);
  let amountUsdcCents: bigint | null = null;
  if (debitedMatch) {
    amountUsdcCents = parseAmountToCents(debitedMatch[1]);
  }

  // Fallback: if title is USD/USDc-denominated, use title amount.
  if (
    (amountUsdcCents === null || amountUsdcCents <= BigInt(0)) &&
    (titleCurrency === "USDC" || titleCurrency === "USD")
  ) {
    amountUsdcCents = parseAmountToCents(titleAmountStr);
  }

  if (amountUsdcCents === null || amountUsdcCents <= BigInt(0)) {
    return { kind: "needs_review", reason: "no_usdc_amount_titled_sent", raw: visibleText };
  }

  // COP amount: from title (if COP-denominated) or from body.
  let copAmountCents: bigint | null = null;
  if (titleCurrency === "COP") {
    copAmountCents = parseAmountToCents(titleAmountStr);
  } else {
    const copMatch = visibleText.match(AMOUNT_SENT_RE);
    if (copMatch && copMatch[2].toUpperCase() === "COP") {
      copAmountCents = parseAmountToCents(copMatch[1]);
    }
  }

  let impliedTrmCopPerUsdc: number | null = null;
  if (copAmountCents !== null && amountUsdcCents > BigInt(0)) {
    impliedTrmCopPerUsdc = Number(copAmountCents) / Number(amountUsdcCents);
  }

  const parsed: ParsedArqTx = {
    txKind: "transfer_sent",
    amountUsdcCents,
    counterpartyName,
    occurredAt,
    copAmountCents,
    impliedTrmCopPerUsdc,
  };
  return { kind: "parsed", ...parsed };
}

/**
 * Return the paragraph that follows `label` in document order, or undefined
 * when the label is absent, its value slot is empty, or the next paragraph is
 * another detail label.
 *
 * Real ARQ emails render detail labels and values as adjacent <p> elements.
 * #921 shipped a fix that fell back to the greeting text when the expected
 * label was missing and silently read the account owner as the counterparty;
 * refusing here is what keeps that class of bug from coming back.
 */
function findDetailValue(paragraphs: string[], label: RegExp): string | undefined {
  const index = paragraphs.findIndex((paragraph) => label.test(paragraph));
  if (index < 0) return undefined;
  const value = paragraphs[index + 1]?.trim();
  if (!value) return undefined;
  if (ARQ_DETAIL_LABEL_RES.some((detailLabel) => detailLabel.test(value))) return undefined;
  return value;
}

/**
 * Parse template 4 — COP payment received (#1015).
 *
 * Expected visible-text structure:
 *   "... COP payment received ... Hello {owner}, You have received {COP} COP
 *    from {sender}. ${USDc} USDc has been added to your balance ...
 *    From | {sender} | Amount Received | {COP} COP |
 *    Amount Added to Balance | ${USDc} USDc | Date | {dd/mm/yyyy hh:mm}"
 *
 * The balance leg (USDc) is the transaction amount; the COP leg is the sender's
 * side and is kept only to derive the implied TRM.
 */
function parseCopPaymentReceived(
  visibleText: string,
  rawHtml: string,
  occurredAt: Date,
): ArqParseResult {
  const paragraphs = extractParagraphTexts(rawHtml);
  const sentence = visibleText.match(COP_RECEIVED_SENTENCE_RE);

  // --- USDc added to balance (the ledger amount) ---
  const addedValue = findDetailValue(paragraphs, LABEL_AMOUNT_ADDED_RE);
  let amountUsdcCents: bigint | null = null;
  if (addedValue !== undefined) {
    const m = addedValue.match(USDC_DETAIL_VALUE_RE);
    if (!m) {
      return { kind: "needs_review", reason: "invalid_usdc_added_amount", raw: visibleText };
    }
    amountUsdcCents = parseAmountToCents(m[1]);
  } else {
    const m = visibleText.match(USD_ADDED_TO_BALANCE_RE);
    if (m) amountUsdcCents = parseAmountToCents(m[1]);
  }
  if (amountUsdcCents === null || amountUsdcCents <= BigInt(0)) {
    return {
      kind: "needs_review",
      reason: addedValue === undefined ? "no_usdc_added_amount" : "invalid_usdc_added_amount",
      raw: visibleText,
    };
  }

  // --- Sender: From detail label first, prose sentence second ---
  const fromValue = findDetailValue(paragraphs, LABEL_FROM_RE);
  const counterpartyName = (fromValue ?? sentence?.[2] ?? "").replace(/\s+/g, " ").trim();
  if (!counterpartyName) {
    return { kind: "needs_review", reason: "no_sender_name", raw: visibleText };
  }

  // --- COP leg (sender's side): optional, but never guessed ---
  const copValue = findDetailValue(paragraphs, LABEL_AMOUNT_RECEIVED_RE);
  let copAmountCents: bigint | null = null;
  if (copValue !== undefined) {
    const m = copValue.match(COP_DETAIL_VALUE_RE);
    copAmountCents = m ? parseAmountToCents(m[1]) : null;
    if (copAmountCents === null) {
      return { kind: "needs_review", reason: "invalid_cop_amount_received", raw: visibleText };
    }
  } else if (sentence?.[1]) {
    copAmountCents = parseAmountToCents(sentence[1]);
  }

  let impliedTrmCopPerUsdc: number | null = null;
  if (copAmountCents !== null && amountUsdcCents > BigInt(0)) {
    impliedTrmCopPerUsdc = Number(copAmountCents) / Number(amountUsdcCents);
  }

  const parsed: ParsedArqTx = {
    txKind: "transfer_received",
    amountUsdcCents,
    counterpartyName,
    occurredAt,
    copAmountCents,
    impliedTrmCopPerUsdc,
  };
  return { kind: "parsed", ...parsed };
}

/**
 * Parse template 3 — transfer_received.
 * <title>You received {amount} USD from {name}</title>
 */
function parseTitledReceived(title: string, visibleText: string, occurredAt: Date): ArqParseResult {
  const m = title.match(TITLED_RECEIVED_RE);
  if (!m) {
    return { kind: "needs_review", reason: "titled_received_no_match", raw: visibleText };
  }
  const titleAmountStr = m[1];
  const titleCurrency = m[2].toUpperCase();
  const counterpartyName = m[3].trim().replace(/\s+/g, " ");

  // USDc credited from body is the canonical ledger amount.
  const creditedMatch = visibleText.match(CREDITED_RE);
  let amountUsdcCents: bigint | null = null;
  if (creditedMatch) {
    amountUsdcCents = parseAmountToCents(creditedMatch[1]);
  }

  // Fallback to title amount.
  if (
    (amountUsdcCents === null || amountUsdcCents <= BigInt(0)) &&
    (titleCurrency === "USD" || titleCurrency === "USDC")
  ) {
    amountUsdcCents = parseAmountToCents(titleAmountStr);
  }

  if (amountUsdcCents === null || amountUsdcCents <= BigInt(0)) {
    return { kind: "needs_review", reason: "no_usdc_amount_received", raw: visibleText };
  }

  const parsed: ParsedArqTx = {
    txKind: "transfer_received",
    amountUsdcCents,
    counterpartyName,
    occurredAt,
    copAmountCents: null,
    impliedTrmCopPerUsdc: null,
  };
  return { kind: "parsed", ...parsed };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse a raw ARQ/DolarApp HTML email and return a typed result.
 *
 * `occurredAt` should be set by the caller from the email's received-at
 * timestamp (pulled from Gmail metadata) since ARQ emails do not embed a
 * machine-readable timestamp in the visible body.
 */
export function parseArqEmail(rawHtml: string, opts: { occurredAt: Date }): ArqParseResult {
  const visibleText = extractVisibleText(rawHtml);
  const { occurredAt } = opts;

  // Skip non-transactional emails first.
  for (const { pattern, reason } of SKIP_PATTERNS) {
    if (pattern.test(visibleText)) {
      return { kind: "skip", reason, raw: visibleText };
    }
  }

  const title = extractRawTitle(rawHtml);

  // Template 3: transfer_received
  if (title && TITLED_RECEIVED_RE.test(title)) {
    return parseTitledReceived(title, visibleText, occurredAt);
  }

  // Template 2: titled transfer_sent
  if (title && TITLED_SENT_RE.test(title)) {
    return parseTitledSent(title, visibleText, occurredAt);
  }

  // Template 4: "COP payment received" (no <title>, #1015). Requires the
  // heading AND real detail structure, so a marketing email that merely
  // mentions the phrase still falls through to needs_review below.
  if (COP_PAYMENT_RECEIVED_MARKER.test(visibleText)) {
    const paragraphs = extractParagraphTexts(rawHtml);
    const hasDetailStructure = paragraphs.some((paragraph) =>
      ARQ_DETAIL_LABEL_RES.some((label) => label.test(paragraph)),
    );
    if (hasDetailStructure || USD_ADDED_TO_BALANCE_RE.test(visibleText)) {
      return parseCopPaymentReceived(visibleText, rawHtml, occurredAt);
    }
  }

  // Template 1: no-title COP transfer sent (47% of corpus — dominant case)
  if (NO_TITLE_SENT_MARKER.test(visibleText)) {
    return parseNoTitleSent(visibleText, rawHtml, occurredAt);
  }

  // Unrecognised — leave pending for manual review or future parser extension.
  return { kind: "needs_review", reason: "unknown_arq_template", raw: visibleText };
}
