import { createLogger } from "@/lib/logger";
import type { GatewayParser, ParseResult } from "./types";

const log = createLogger({ module: "gmail/parsers/payu" });

// PayU receipts: labeled-table format with decoded HTML entities.
// Key signals:
//   Approved: "Tu transacción ha sido aprobada" + "fue aprobada"
//   Rejected: "fue rechazada" or "rechazado"
//   Card reg:  "Tarjeta registrada" (no purchase)
//
// Amount field "Valor" is raw integer COP units (e.g. 137000 = 137 000 COP).
// Multiply by 100 to get cents.
//
// Date "Fecha" is in Bogotá local time (UTC-5, no DST).
// Stored as UTC by subtracting 5 hours.

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC-5 in ms

function extractVisibleText(rawHtml: string): string {
  let t = rawHtml;
  t = t.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ");
  t = t.replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities before further processing
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function parseBogotaDate(dateStr: string, timeStr: string): Date {
  // dateStr: "2026-04-22", timeStr: "13:11:21"
  const localMs = new Date(`${dateStr}T${timeStr}Z`).getTime();
  // Shift from Bogotá local (UTC-5) to UTC
  return new Date(localMs + BOGOTA_OFFSET_MS);
}

export const payuParser: GatewayParser = {
  parse(html: string, opts?: { receivedAt?: Date }): ParseResult {
    try {
      const text = extractVisibleText(html);

      // Card registration notification — not a purchase
      if (/Tarjeta\s+registrada/i.test(text) && !/fue\s+aprobada/i.test(text)) {
        return { kind: "skipped", reason: "card_registration" };
      }

      // Rejected transaction
      if (/fue\s+rechazad[ao]/i.test(text) || /rechazad[ao]/i.test(text)) {
        return { kind: "skipped", reason: "rejected" };
      }

      // Approved transaction
      if (
        /Tu\s+transacci[oó]n\s+ha\s+sido\s+aprobada/i.test(text) &&
        /fue\s+aprobada/i.test(text)
      ) {
        // Merchant: between "realizada en " and " , fue aprobada" (space before comma)
        const merchantMatch = text.match(/realizada\s+en\s+(.+?)\s*,\s*fue\s+aprobada/i);
        if (!merchantMatch) {
          log.warn(
            { event: "payu_merchant_not_found" },
            "could not extract merchant from PayU email",
          );
          return { kind: "needs_review", reason: "merchant_not_found" };
        }
        const merchant = merchantMatch[1].trim();

        // Reference: labeled row "Referencia <VALUE>" — NOT the inline uuid in the body sentence
        // The labeled row appears as "Referencia CORBL-18622" or "Referencia 3aac1d8e-..."
        // We take the last occurrence of "Referencia <value>" since it's the labeled table row
        const refMatches = [...text.matchAll(/Referencia\s+([A-Za-z0-9-]+)/g)];
        const referenceId = refMatches.length > 0 ? refMatches[refMatches.length - 1][1] : null;

        // Amount: "Valor <integer>" in COP units → × 100 for cents
        const amountMatch = text.match(/Valor\s+(\d+)/);
        if (!amountMatch) {
          log.warn({ event: "payu_amount_not_found" }, "could not extract amount from PayU email");
          return { kind: "needs_review", reason: "amount_not_found" };
        }
        const amountCents = BigInt(amountMatch[1]) * BigInt(100);

        // Currency: "Moneda COP" / "Moneda USD"
        const currencyMatch = text.match(/Moneda\s+([A-Z]{3})/);
        const currency: "COP" | "USD" = currencyMatch && currencyMatch[1] === "USD" ? "USD" : "COP";

        // Date: "Fecha 2026-04-22 13:11:21"
        const dateMatch = text.match(/Fecha\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        let occurredAt: Date;
        if (dateMatch) {
          occurredAt = parseBogotaDate(dateMatch[1], dateMatch[2]);
        } else if (opts?.receivedAt) {
          log.warn(
            { event: "payu_date_fallback" },
            "PayU email missing Fecha field; using receivedAt",
          );
          occurredAt = opts.receivedAt;
        } else {
          return { kind: "needs_review", reason: "missing_occurred_at" };
        }

        return {
          kind: "parsed",
          data: { merchant, amountCents, currency, occurredAt, referenceId },
        };
      }

      // Unrecognised PayU email type
      return { kind: "needs_review", reason: "unknown_payu_email_type" };
    } catch (err) {
      log.error({ err, event: "payu_parse_error" }, "unexpected error parsing PayU email");
      return { kind: "needs_review", reason: "parse_error" };
    }
  },
};
