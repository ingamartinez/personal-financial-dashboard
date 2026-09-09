import { createLogger } from "@/lib/logger";
import { extractVisibleText } from "./_text";
import type { GatewayParser, ParseResult } from "./types";

const log = createLogger({ module: "gmail/parsers/mercado-pago" });

// Mercado Pago receipt emails (Colombian variant):
//   - Transactional signal: "Pagaste" AND/OR "Le compraste a"
//   - Promotional signal: no "Pagaste", no "Le compraste a"
//
// Amount format uses period as thousands separator and comma as decimal:
//   "$ 152.800"  → 152 800 COP → 15 280 000 cents
//   "$ 1.234,56" → 1 234.56 COP → 123 456 cents
//
// Date: Spanish prose "23 de abril a las 11:26 hs" — year from opts.receivedAt.
// Times are in Bogotá local time (UTC-5, no DST).
//
// Merchant: appears after "Le compraste a" — may be duplicated due to image
// alt text rendering. We take the first occurrence.

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC-5 in ms

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

function parseMpAmount(intStr: string, decStr?: string): bigint {
  // Remove period thousands separators → integer COP
  const cop = BigInt(intStr.replace(/\./g, ""));
  const cents = cop * BigInt(100);
  if (decStr) {
    const dec = BigInt(decStr.padEnd(2, "0").slice(0, 2));
    return cents + dec;
  }
  return cents;
}

function parseSpanishDate(
  day: string,
  monthName: string,
  hour: string,
  minute: string,
  year: number,
): Date | null {
  const month = SPANISH_MONTHS[monthName.toLowerCase()];
  if (!month) return null;

  const d = parseInt(day, 10);
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (isNaN(d) || isNaN(h) || isNaN(m)) return null;

  // Construct as Bogotá local time then shift to UTC
  const localMs = Date.UTC(year, month - 1, d, h, m, 0);
  return new Date(localMs + BOGOTA_OFFSET_MS);
}

const VOUCHER_NETWORK_RE = /REDEBAN ES SU RED|CREDIBANCO ES SU RED/i;
const MERCHANT_MAX = 200;

function truncateMerchant(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MERCHANT_MAX) return trimmed;
  return trimmed.slice(0, MERCHANT_MAX);
}

function stripComprastePrefix(value: string): string {
  return value.replace(/^Compraste\s+/i, "").trim();
}

function parseVoucherDate(dmy: string, hms: string): Date | null {
  const dateParts = dmy.split("/");
  const timeParts = hms.split(":");
  if (dateParts.length !== 3 || timeParts.length < 2) return null;
  const day = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const year = Number(dateParts[2]);
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  const second = timeParts[2] !== undefined ? Number(timeParts[2]) : 0;
  if (![day, month, year, hour, minute, second].every((n) => Number.isFinite(n))) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const localMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(localMs + BOGOTA_OFFSET_MS);
}

function extractVoucherAmount(text: string): bigint | null {
  // Card-leg amount lives on the voucher, never the "Pagaste" headline
  // (split payments charge the card less than the order total). Prefer
  // TOTAL, then COMPRA NETA. Formats observed: "$85211" and "$85.211".
  const match =
    text.match(/TOTAL:\s*\$\s*([\d.]+)(?:,(\d{2}))?/i) ??
    text.match(/COMPRA\s+NETA:\s*\$\s*([\d.]+)(?:,(\d{2}))?/i);
  if (!match) return null;
  return parseMpAmount(match[1], match[2]);
}

function extractMlMerchant(html: string, subject: string | undefined): string {
  // extractVisibleText keeps <title> contents. Strip it so a default
  // subject-in-title does not glue onto the body "Compraste …" line.
  const htmlWithoutTitle = html.replace(/<title[^>]*>[\s\S]*?<\/title[^>]*>/gi, " ");
  const bodyText = extractVisibleText(htmlWithoutTitle);
  const compraste = bodyText.match(
    /Compraste\s+(.+?)(?=\s+(?:Pagaste|REDEBAN|CREDIBANCO|Le\s+compraste)|$)/i,
  );
  if (compraste) {
    const product = compraste[1].trim();
    if (!/^\d+\s+productos\b/i.test(product)) return truncateMerchant(product);
  }
  if (subject) {
    const fromSubject = stripComprastePrefix(subject);
    if (fromSubject) return truncateMerchant(fromSubject);
  }
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) {
    const fromTitle = stripComprastePrefix(title[1]);
    if (fromTitle) return truncateMerchant(fromTitle);
  }
  return "MERCADOPAGO COLOMBIA";
}

function parseVoucherBlock(
  html: string,
  text: string,
  opts?: { receivedAt?: Date; subject?: string },
): ParseResult {
  const amountCents = extractVoucherAmount(text);
  if (amountCents === null) {
    log.warn({ event: "mp_voucher_amount_not_found" }, "voucher block missing TOTAL/COMPRA NETA");
    return { kind: "needs_review", reason: "voucher_amount_not_found" };
  }

  const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  let occurredAt: Date;
  if (dateMatch) {
    const parsed = parseVoucherDate(dateMatch[1], dateMatch[2]);
    if (!parsed) {
      log.warn(
        { raw: dateMatch[0], event: "mp_voucher_date_parse_failed" },
        "could not parse voucher date",
      );
      return { kind: "needs_review", reason: "date_parse_failed" };
    }
    occurredAt = parsed;
  } else if (opts?.receivedAt) {
    log.warn({ event: "mp_voucher_date_fallback" }, "voucher missing datetime; using receivedAt");
    occurredAt = opts.receivedAt;
  } else {
    return { kind: "needs_review", reason: "missing_occurred_at" };
  }

  const autMatch = text.match(/AUT:\s*(\d+)/i);
  const refMatch = text.match(/REF:\s*(\d+)/i);
  const last4Match = text.match(/\*{4}\s*(\d{4})/);
  const cuotasMatch = text.match(/CUOTAS:\s*(\d+)/i);
  const network = /CREDIBANCO ES SU RED/i.test(text)
    ? "credibanco"
    : /REDEBAN ES SU RED/i.test(text)
      ? "redeban"
      : null;

  const extra: Record<string, unknown> = {};
  if (network) extra.network = network;
  if (last4Match) extra.last4 = last4Match[1];
  if (cuotasMatch) extra.installments = Number(cuotasMatch[1]);
  if (refMatch) extra.ref = refMatch[1];

  return {
    kind: "parsed",
    data: {
      merchant: extractMlMerchant(html, opts?.subject),
      amountCents,
      currency: "COP",
      occurredAt,
      referenceId: autMatch ? autMatch[1] : (refMatch?.[1] ?? null),
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    },
  };
}

export const mercadoPagoParser: GatewayParser = {
  parse(html: string, opts?: { receivedAt?: Date; subject?: string }): ParseResult {
    try {
      const text = extractVisibleText(html);

      // Voucher-block layout (Mercado Libre "Compraste …" and some MP
      // checkout mail). Must run BEFORE the Pagaste/Le-compraste path:
      // split payments put the order total on "Pagaste" and the card leg
      // on TOTAL:/COMPRA NETA:. findash holds the card leg.
      if (VOUCHER_NETWORK_RE.test(text)) {
        return parseVoucherBlock(html, text, opts);
      }

      // Promotional / non-transactional check
      if (!/Pagaste/i.test(text) && !/Le\s+compraste\s+a/i.test(text)) {
        return { kind: "skipped", reason: "non_transactional" };
      }

      // Extract merchant: first occurrence of "Le compraste a <MERCHANT>"
      // The sentence ends at "Tu pago fue aprobado" or a duplicate of itself.
      const merchantMatch = text.match(/Le\s+compraste\s+a\s+(.+?)(?=Le\s+compraste|Tu\s+pago|$)/i);
      if (!merchantMatch) {
        log.warn({ event: "mp_merchant_not_found" }, "could not extract merchant from MP email");
        return { kind: "needs_review", reason: "merchant_not_found" };
      }
      const merchant = merchantMatch[1].trim();

      // Amount: "Pagaste $ 152.800" (period=thousands, no decimal)
      // or "Pagaste $ 1.234,56" (period=thousands, comma=decimal)
      const amountMatch = text.match(/Pagaste\s+\$\s*([\d.]+)(?:,(\d{2}))?/i);
      if (!amountMatch) {
        log.warn({ event: "mp_amount_not_found" }, "could not extract amount from MP email");
        return { kind: "needs_review", reason: "amount_not_found" };
      }
      const amountCents = parseMpAmount(amountMatch[1], amountMatch[2]);

      // Reference: "N.° de operación 155335418627"
      const refMatch = text.match(/N\.°\s*de\s+operaci[oó]n\s*(\d+)/i);
      const referenceId = refMatch ? refMatch[1] : null;

      // Currency: Colombian MP uses COP; no currency marker in body so default COP
      const currency: "COP" | "USD" = "COP";

      // Date: "23 de abril a las 11:26 hs"
      const dateMatch = text.match(
        /(\d{1,2})\s+de\s+([a-záéíóú]+)\s+a\s+las\s+(\d{1,2}):(\d{2})\s*hs/i,
      );
      let occurredAt: Date;
      if (dateMatch) {
        const bodyMonth = SPANISH_MONTHS[dateMatch[2].toLowerCase()];
        const receivedYear = opts?.receivedAt?.getUTCFullYear() ?? new Date().getUTCFullYear();
        // Year-boundary correction: if the email body says December (month=12) but
        // receivedAt is already in January UTC (the email arrived just after midnight
        // UTC on Jan 1), the payment was made at 23:xx Bogotá on Dec 31 of the prior
        // year. Use receivedYear - 1 in that case.
        const year =
          bodyMonth === 12 && opts?.receivedAt?.getUTCMonth() === 0
            ? receivedYear - 1
            : receivedYear;
        const parsed = parseSpanishDate(
          dateMatch[1],
          dateMatch[2],
          dateMatch[3],
          dateMatch[4],
          year,
        );
        if (!parsed) {
          log.warn(
            { raw: dateMatch[0], event: "mp_date_parse_failed" },
            "could not parse MP date string",
          );
          return { kind: "needs_review", reason: "date_parse_failed" };
        }
        occurredAt = parsed;
      } else if (opts?.receivedAt) {
        log.warn({ event: "mp_date_fallback" }, "MP email missing date field; using receivedAt");
        occurredAt = opts.receivedAt;
      } else {
        return { kind: "needs_review", reason: "missing_occurred_at" };
      }

      return {
        kind: "parsed",
        data: { merchant, amountCents, currency, occurredAt, referenceId },
      };
    } catch (err) {
      log.error({ err, event: "mp_parse_error" }, "unexpected error parsing MercadoPago email");
      return { kind: "needs_review", reason: "parse_error" };
    }
  },
};
