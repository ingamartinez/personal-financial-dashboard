import { createLogger } from "@/lib/logger";
import { extractVisibleText } from "./_text";
import type { GatewayParser, ParseResult } from "./types";

const log = createLogger({ module: "gmail/parsers/paypal" });

// PayPal receipt emails (Colombian account, Spanish locale):
//
// TWO receipt templates observed in prod:
//
// 1. Direct payment (RT001736):
//    Signal:   "Ha pagado $<AMT> <CUR> a <MERCHANT>"
//    Amount:   "$29.900 COP"  — period = thousands sep, no decimal (COP)
//              "€2,50 EUR"    — comma = decimal (EUR — unsupported → needs_review)
//    Date:     "Fecha de la transacción DD/MM/YYYY"  (full year, no boundary issue)
//    Merchant: appears after "Ha pagado $X CUR a " up to " Ver"
//    TxID:     "Id. de transacción <ALPHANUM>"
//
// 2. Recurring/automatic payment:
//    Signal:   "Envió un pago automático a <MERCHANT>"
//    Amount:   "Importe del pago $ 6,99 USD"  — space, comma = decimal (USD)
//    Date:     "Fecha de la transacción D de MES de YYYY"  (Spanish long form)
//    Merchant: appears after "Envió un pago automático a " up to " Alejandro" or ","
//    TxID:     "Id. de transacción <ALPHANUM>"
//
// Non-receipts → skipped:
//   - "canceló los pagos automáticos" (auto-pay cancellation notice)
//   - Policy/legal notices (no "Ha pagado" or "Envió un pago automático")
//
// Currency: COP and USD only. EUR → needs_review "unsupported_currency".
//
// All PayPal receipt dates include the full 4-digit year — no year-boundary risk.
// No fallback to opts.receivedAt — if date is missing, return needs_review.
// (Wompi-pattern: never fall back silently when the date is structural.)

const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/**
 * Parse "DD/MM/YYYY" (direct payment template).
 * Returns UTC midnight of that calendar date (no time-of-day in PayPal emails).
 */
function parseShortDate(raw: string): Date | null {
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  // PayPal shows local calendar date — store as UTC midnight of that date
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Parse "D de MONTH de YYYY" (recurring payment template).
 * Returns UTC midnight of that calendar date.
 */
function parseSpanishLongDate(raw: string): Date | null {
  const m = raw.match(/^(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})$/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = SPANISH_MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (!month || isNaN(day) || isNaN(year)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Parse COP amount — period = thousands separator, no cents.
 * "$29.900 COP" → BigInt(2990000)
 */
function parseCopAmount(raw: string): bigint | null {
  // raw is the digits+dots part e.g. "29.900"
  const digits = raw.replace(/\./g, "");
  if (!/^\d+$/.test(digits)) return null;
  return BigInt(digits) * BigInt(100);
}

/**
 * Parse USD amount — comma = decimal separator.
 * "6,99" → BigInt(699)
 */
function parseUsdAmount(raw: string): bigint | null {
  // raw is the digits+comma part e.g. "6,99"
  const parts = raw.split(",");
  if (parts.length === 1) {
    const n = parseInt(parts[0], 10);
    if (isNaN(n)) return null;
    return BigInt(n) * BigInt(100);
  }
  if (parts.length === 2) {
    const dollars = parseInt(parts[0], 10);
    const cents = parseInt(parts[1].padEnd(2, "0").slice(0, 2), 10);
    if (isNaN(dollars) || isNaN(cents)) return null;
    return BigInt(dollars) * BigInt(100) + BigInt(cents);
  }
  return null;
}

export const paypalParser: GatewayParser = {
  parse(html: string, _opts?: { receivedAt?: Date }): ParseResult {
    try {
      const text = extractVisibleText(html);

      // ── Non-receipt: auto-pay cancellation ──────────────────────────────────
      if (/cancel[oó]\s+los\s+pagos\s+autom[aá]ticos/i.test(text)) {
        return { kind: "skipped", reason: "autopay_cancellation" };
      }

      // ── Branch A: direct payment ("Ha pagado") ──────────────────────────────
      if (/Ha\s+pagado/i.test(text)) {
        // Merchant: "Ha pagado $X CUR a <MERCHANT> Ver"
        const merchantMatch = text.match(
          /Ha\s+pagado\s+[\$€][\d.,]+\s+[A-Z]{3}\s+a\s+(.+?)\s+Ver\b/i,
        );
        if (!merchantMatch) {
          log.warn({ event: "paypal_merchant_not_found_a" }, "could not extract merchant (type A)");
          return { kind: "needs_review", reason: "merchant_not_found" };
        }
        const merchant = merchantMatch[1].trim();

        // Currency: look for COP / USD / EUR in "Ha pagado $X CUR"
        const currencyMatch = text.match(/Ha\s+pagado\s+[\$€][\d.,]+\s+([A-Z]{3})/i);
        const rawCurrency = currencyMatch ? currencyMatch[1].toUpperCase() : null;

        if (!rawCurrency || (rawCurrency !== "COP" && rawCurrency !== "USD")) {
          log.warn(
            { currency: rawCurrency, event: "paypal_unsupported_currency" },
            "unsupported currency in PayPal receipt",
          );
          return { kind: "needs_review", reason: "unsupported_currency" };
        }
        const currency = rawCurrency as "COP" | "USD";

        // Amount: extract the number part from "Ha pagado $<NUM> CUR"
        let amountCents: bigint | null = null;
        if (currency === "COP") {
          const amtMatch = text.match(/Ha\s+pagado\s+\$([\d.]+)\s+COP/i);
          if (amtMatch) amountCents = parseCopAmount(amtMatch[1]);
        } else {
          // USD in direct payment template uses comma decimal
          const amtMatch = text.match(/Ha\s+pagado\s+\$([\d,]+)\s+USD/i);
          if (amtMatch) amountCents = parseUsdAmount(amtMatch[1]);
        }

        if (amountCents === null) {
          log.warn({ event: "paypal_amount_not_found_a" }, "could not extract amount (type A)");
          return { kind: "needs_review", reason: "amount_not_found" };
        }

        // Reference ID: "Id. de transacción <ALPHANUM>"
        const refMatch = text.match(/Id\.\s*de\s+transacci[oó]n\s+([A-Z0-9]+)/i);
        const referenceId = refMatch ? refMatch[1] : null;

        // Date: "Fecha de la transacción DD/MM/YYYY"
        const dateMatch = text.match(
          /Fecha\s+de\s+la\s+transacci[oó]n\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
        );
        if (!dateMatch) {
          log.warn({ event: "paypal_date_not_found_a" }, "could not extract date (type A)");
          return { kind: "needs_review", reason: "missing_occurred_at" };
        }
        const occurredAt = parseShortDate(dateMatch[1]);
        if (!occurredAt) {
          log.warn(
            { raw: dateMatch[1], event: "paypal_date_parse_failed_a" },
            "could not parse PayPal date (type A)",
          );
          return { kind: "needs_review", reason: "date_parse_failed" };
        }

        return {
          kind: "parsed",
          data: { merchant, amountCents, currency, occurredAt, referenceId },
        };
      }

      // ── Branch B: recurring/automatic payment ("Envió un pago automático") ──
      if (/Envi[oó]\s+un\s+pago\s+autom[aá]tico\s+a\b/i.test(text)) {
        // Merchant: use "Gracias por su pago a <MERCHANT>. Estos son" from the body.
        // The subject line reads "Envió un pago automático a <MERCHANT> <UserFullName>,"
        // which is user-name-dependent and fragile. The body sentence terminates with
        // ". Estos son" (details intro) making it a clean, user-name-independent anchor.
        // Fallback: stop at ". " (period + space) to handle other phrase endings.
        const merchantMatch =
          text.match(
            /Gracias\s+por\s+su\s+pago\s+a\s+(.+?)(?=\.\s+(?:Estos|Aqu[ií]|Hola|Los|\s*$))/i,
          ) ?? text.match(/Gracias\s+por\s+su\s+pago\s+a\s+(.+?)\.\s/i);
        if (!merchantMatch) {
          log.warn(
            { event: "paypal_merchant_not_found_b" },
            "could not extract merchant from 'Gracias por su pago a' sentence (type B)",
          );
          return { kind: "needs_review", reason: "merchant_not_found" };
        }
        const merchant = merchantMatch[1].trim();

        // Currency: "Importe del pago $ X,XX USD"
        const currencyMatch = text.match(/Importe\s+del\s+pago\s+\$\s*[\d,]+\s+([A-Z]{3})/i);
        const rawCurrency = currencyMatch ? currencyMatch[1].toUpperCase() : null;

        if (!rawCurrency || (rawCurrency !== "COP" && rawCurrency !== "USD")) {
          log.warn(
            { currency: rawCurrency, event: "paypal_unsupported_currency_b" },
            "unsupported currency in PayPal auto-payment receipt",
          );
          return { kind: "needs_review", reason: "unsupported_currency" };
        }
        const currency = rawCurrency as "COP" | "USD";

        // Amount: "Importe del pago $ 6,99 USD"
        let amountCents: bigint | null = null;
        if (currency === "USD") {
          const amtMatch = text.match(/Importe\s+del\s+pago\s+\$\s*([\d,]+)\s+USD/i);
          if (amtMatch) amountCents = parseUsdAmount(amtMatch[1]);
        } else {
          const amtMatch = text.match(/Importe\s+del\s+pago\s+\$\s*([\d.]+)\s+COP/i);
          if (amtMatch) amountCents = parseCopAmount(amtMatch[1]);
        }

        if (amountCents === null) {
          log.warn({ event: "paypal_amount_not_found_b" }, "could not extract amount (type B)");
          return { kind: "needs_review", reason: "amount_not_found" };
        }

        // Reference ID: "Id. de transacción <ALPHANUM>"
        const refMatch = text.match(/Id\.\s*de\s+transacci[oó]n\s+([A-Z0-9]+)/i);
        const referenceId = refMatch ? refMatch[1] : null;

        // Date: "Fecha de la transacción D de MES de YYYY"
        const dateMatch = text.match(
          /Fecha\s+de\s+la\s+transacci[oó]n\s+(\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4})/i,
        );
        if (!dateMatch) {
          log.warn({ event: "paypal_date_not_found_b" }, "could not extract date (type B)");
          return { kind: "needs_review", reason: "missing_occurred_at" };
        }
        const occurredAt = parseSpanishLongDate(dateMatch[1]);
        if (!occurredAt) {
          log.warn(
            { raw: dateMatch[1], event: "paypal_date_parse_failed_b" },
            "could not parse PayPal date (type B)",
          );
          return { kind: "needs_review", reason: "date_parse_failed" };
        }

        return {
          kind: "parsed",
          data: { merchant, amountCents, currency, occurredAt, referenceId },
        };
      }

      // ── Non-receipt: any other PayPal email ─────────────────────────────────
      return { kind: "skipped", reason: "non_receipt" };
    } catch (err) {
      log.error({ err, event: "paypal_parse_error" }, "unexpected error parsing PayPal email");
      return { kind: "needs_review", reason: "parse_error" };
    }
  },
};
