import { createLogger } from "@/lib/logger";
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

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  zwnj: "",
  deg: "°",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
};

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&([A-Za-z]+);/g, (match, name) => NAMED_ENTITIES[name] ?? match)
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}

function extractVisibleText(rawHtml: string): string {
  let t = rawHtml;
  t = t.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ");
  t = t.replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeHtmlEntities(t);
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

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

export const mercadoPagoParser: GatewayParser = {
  parse(html: string, opts?: { receivedAt?: Date }): ParseResult {
    try {
      const text = extractVisibleText(html);

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
        const year = opts?.receivedAt?.getUTCFullYear() ?? new Date().getUTCFullYear();
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
