import { createLogger } from "@/lib/logger";
import type { GatewayParser, ParseResult } from "./types";

const log = createLogger({ module: "gmail/parsers/apple" });

// Apple email parser — handles multiple email types from @email.apple.com:
//
//   INVOICE (parse):   "Invoice" + ("Order ID:" or "ORDER ID") + Order details + Subtotal/TOTAL
//   RECEIPT (parse):   "Receipt" + "Order ID:" — same parse path as Invoice
//   RECENT_PURCHASE:   "Recent Purchase" — security alert, skip
//   SUBSCRIPTION_CONFIRMED: "Subscription Confirmed" — free trial, no charge, skip
//   SUBSCRIPTION_EXPIRING:  "Subscription Expir" — upcoming expiry, no charge, skip
//   DEVELOPER_AGREEMENT:    "signed the following agreement" — skip
//   OTHER (family, etc.):   no billing data, skip
//
// Amount: Colombian Apple COP format uses period as thousands separator.
//   "$ 29.900" = 29 900 COP = 2 990 000 cents
// Non-breaking space (\xa0) appears between $ and digits in some layouts.
//
// Date: English prose "22 April 2026" or "INVOICE DATE 20 Apr 2026".
// No timezone info — Apple invoices are date-only; we use midnight UTC.
//
// Merchant: the app/service name, found between Account email and
// Renews/Monthly/Yearly/One-time/Annual/In-App keywords, or item name
// in alt-invoice layouts.

const ENGLISH_MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function extractVisibleText(rawHtml: string): string {
  let t = rawHtml;
  t = t.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ");
  t = t.replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<[^>]+>/g, " ");
  // Normalise non-breaking spaces and other whitespace-like chars
  t = t.replace(/ /g, " ").replace(/&nbsp;/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function parseAppleDate(dateStr: string): Date | null {
  // Formats observed in prod:
  //   "22 April 2026"  (Invoice header)
  //   "20 Apr 2026"    (alt-invoice INVOICE DATE field)
  //   "4 April 2026"   (Receipt header)
  const m = dateStr.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = ENGLISH_MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (!month || isNaN(day) || isNaN(year)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function parseAppleAmount(raw: string): bigint | null {
  // Strip leading $ and whitespace (including \xa0)
  const cleaned = raw.replace(/^\$[\s ]*/u, "").trim();
  // Colombian format: period=thousands, optional comma+decimal
  // e.g. "29.900" → 29900 COP | "1.234,56" → 1234.56 COP
  const m = cleaned.match(/^([\d.]+)(?:,(\d{2}))?$/);
  if (!m) return null;
  const cop = BigInt(m[1].replace(/\./g, ""));
  const cents = cop * BigInt(100);
  if (m[2]) {
    return cents + BigInt(m[2].padEnd(2, "0").slice(0, 2));
  }
  return cents;
}

/**
 * Trim the subscription plan suffix from a raw "app name + plan name" string.
 *
 * Apple invoices collapse the app name and plan name into one text segment.
 * The plan name often repeats a key word from the app name (e.g.
 * "Tinder: citas, chat y amigos" → plan "Tinder Platinum"). This function
 * detects that repetition and trims from the second occurrence.
 *
 * Steps:
 * 1. Strip trailing plan keywords if first-word repeats (e.g. "Tinder Tinder…").
 * 2. Walk backwards to find any word that already appeared earlier in the
 *    segment — the repetition signals the start of the plan name.
 */
function trimPlanNameSuffix(raw: string): string {
  const words = raw.split(/\s+/);
  if (words.length <= 1) return raw;

  // Step 1: repeated first word (exact match, case-insensitive, ignoring punctuation)
  const firstWordKey = words[0].replace(/[^a-zA-Z]/g, "").toLowerCase();
  const dupIdx = words.findIndex(
    (w, i) => i > 0 && w.replace(/[^a-zA-Z]/g, "").toLowerCase() === firstWordKey,
  );
  if (dupIdx > 0) {
    return words.slice(0, dupIdx).join(" ");
  }

  // Step 2: walk backwards — find any word (>2 chars) that already appeared
  // earlier in the segment
  for (let i = words.length - 1; i > 0; i--) {
    const wKey = words[i].replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (
      wKey.length > 2 &&
      words.slice(0, i).some((prev) => prev.replace(/[^a-zA-Z]/g, "").toLowerCase() === wKey)
    ) {
      return words.slice(0, i).join(" ").trim();
    }
  }

  return raw;
}

export const appleParser: GatewayParser = {
  parse(html: string, _opts?: { receivedAt?: Date }): ParseResult {
    try {
      const text = extractVisibleText(html);

      // ----- Skip conditions (ordered by specificity) -----

      if (/Recent\s+Purchase/i.test(text)) {
        return { kind: "skipped", reason: "recent_purchase_alert" };
      }

      if (/Subscription\s+Confirmed/i.test(text)) {
        return { kind: "skipped", reason: "subscription_confirmed_trial" };
      }

      if (/Subscription\s+Expir/i.test(text)) {
        return { kind: "skipped", reason: "subscription_expiring" };
      }

      if (
        /signed\s+the\s+following\s+agreement/i.test(text) ||
        /Developer\s+Agreement/i.test(text)
      ) {
        return { kind: "skipped", reason: "developer_agreement" };
      }

      // ----- Invoice / Receipt parse -----

      // Both "Invoice" and "Receipt" (iCloud uses "Receipt") are parseable
      const isInvoice = /\bInvoice\b/i.test(text) || /\bReceipt\b/i.test(text);
      // Must have an order ID in any of the known layouts
      const hasOrderId =
        /Order\s+ID[:.]?\s*[A-Z0-9]+/i.test(text) || /ORDER\s+ID\s+[A-Z0-9]+/i.test(text);

      if (isInvoice && hasOrderId) {
        // ----- Extract Order ID -----
        // Two layouts:
        //   Layout A: "Order ID: MKX7GM3GZ0"
        //   Layout B: "ORDER ID MKX7GG8HKQ" (no colon)
        const orderIdMatch =
          text.match(/Order\s+ID:\s*([A-Z0-9]+)/i) ?? text.match(/ORDER\s+ID\s+([A-Z0-9]+)/i);
        const referenceId = orderIdMatch ? orderIdMatch[1] : null;

        // ----- Extract Total Amount -----
        // Strategy: find the amount that follows a card line (MasterCard/Visa/etc.)
        // which is always the final charge amount. This works for both single and
        // multi-item invoices.
        //
        // Pattern: "MasterCard •••• XXXX $ 29.900" or "Visa •••• XXXX $ 24.900"
        const cardLineMatch = text.match(
          /(?:MasterCard|Visa|American\s+Express|Apple\s+Pay)[^\n$]*?\$[\s ]*([\d.,]+)/iu,
        );

        // Fallback: try "TOTAL $ <amount>" for alt-invoice layouts
        const totalLineMatch = text.match(/\bTOTAL\s+\$[\s ]*([\d.,]+)/i);

        // Also try "Subtotal $ <amount>" for iCloud Receipt which has no VAT line
        const subtotalMatch = text.match(/Subtotal\s+\$[\s ]*([\d.,]+)/i);

        const rawAmount = cardLineMatch?.[1] ?? totalLineMatch?.[1] ?? subtotalMatch?.[1];

        if (!rawAmount) {
          log.warn(
            { event: "apple_amount_not_found" },
            "could not extract total amount from Apple invoice",
          );
          return { kind: "needs_review", reason: "amount_not_found" };
        }

        const amountCents = parseAppleAmount(rawAmount);
        if (amountCents === null) {
          log.warn(
            { raw: rawAmount, event: "apple_amount_parse_failed" },
            "could not parse Apple amount string",
          );
          return { kind: "needs_review", reason: "amount_parse_failed" };
        }

        // ----- Extract Date -----
        // Layout A: starts with "Invoice 22 April 2026" or "Receipt 4 April 2026"
        // Layout B: "INVOICE DATE 20 Apr 2026"
        const datePrefixMatch =
          text.match(/^(?:Invoice|Receipt)\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i) ??
          text.match(/(?:Invoice|Invoice\s+Date|INVOICE\s+DATE)\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);

        let occurredAt: Date | null = null;
        if (datePrefixMatch) {
          occurredAt = parseAppleDate(datePrefixMatch[1]);
        }

        if (!occurredAt) {
          log.warn({ event: "apple_date_not_found" }, "could not extract date from Apple invoice");
          return { kind: "needs_review", reason: "date_not_found" };
        }

        // ----- Extract Merchant -----
        // Layout A: app name appears after "Apple Account: <email>" and before
        // "Monthly|Yearly|One-time|Annual|In-App Purchase|Renews"
        // Layout B (alt-invoice): app name appears after "DOCUMENT NO. <number>"
        // and before "In-App Purchase".
        //
        // Multi-item invoices (apple-28): contain multiple app names — we use
        // the first one found.
        //
        // Merchant extraction heuristic for Layout A:
        // 1. Capture text from account email to first Monthly/Yearly/Annual/Renews.
        // 2. Check for a repeated first-word (e.g. "Tinder: ... Tinder Platinum" →
        //    take before second "Tinder"). Handles most plan-name repetition cases.
        // 3. Walk backwards from end to find any word that already appeared earlier
        //    in the segment (handles "Proton VPN: ... VPN Plus" → "VPN" repeats).
        let merchant = "";

        // Layout A: after Apple Account email
        const accountEmailMatch = text.match(
          /Apple\s+Account:\s+[^\s@]+@[^\s]+\s+(.+?)\s+(?:Monthly|Yearly|Annual|One[-\s]time|In-App|Renews)/i,
        );
        if (accountEmailMatch) {
          const raw = accountEmailMatch[1].trim();
          merchant = trimPlanNameSuffix(raw);
        }

        // Layout B: alt-invoice — no "Apple Account:" label, item name appears
        // after "DOCUMENT NO. <number>" and before "In-App Purchase"
        if (!merchant) {
          const docNoMatch = text.match(
            /DOCUMENT\s+NO\.?\s+\d+\s+(.+?)\s+(?:In-App\s+Purchase|Report\s+a\s+Problem)/i,
          );
          if (docNoMatch) {
            merchant = docNoMatch[1].trim();
          }
        }

        // Last resort: find any word-token between account email and "Renews"
        if (!merchant) {
          const emailInTextMatch = text.match(/[^\s@]+@[^\s]+/);
          if (emailInTextMatch) {
            const afterEmail = text.slice(
              text.indexOf(emailInTextMatch[0]) + emailInTextMatch[0].length,
            );
            const fallbackMatch = afterEmail.match(/^\s+(.+?)\s+(?:Monthly|Yearly|Renews|In-App)/i);
            if (fallbackMatch) {
              merchant = trimPlanNameSuffix(fallbackMatch[1].trim());
            }
          }
        }

        if (!merchant) {
          log.warn(
            { event: "apple_merchant_not_found" },
            "could not extract merchant from Apple invoice",
          );
          return { kind: "needs_review", reason: "merchant_not_found" };
        }

        return {
          kind: "parsed",
          data: {
            merchant,
            amountCents,
            currency: "COP",
            occurredAt,
            referenceId,
          },
        };
      }

      // Unrecognised Apple email type
      return { kind: "needs_review", reason: "unrecognized_apple_email_type" };
    } catch (err) {
      log.error({ err, event: "apple_parse_error" }, "unexpected error parsing Apple email");
      return { kind: "needs_review", reason: "parse_error" };
    }
  },
};
