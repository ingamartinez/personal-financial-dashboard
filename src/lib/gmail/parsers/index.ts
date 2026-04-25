import { createLogger } from "@/lib/logger";
import type { GatewayId } from "@/lib/gmail/registry";
import type { ParseResult } from "./types";
import { mercadoPagoParser } from "./mercado-pago";
import { payuParser } from "./payu";
import { wompiParser } from "./wompi";
import { appleParser } from "./apple";
import { paypalParser } from "./paypal";

const log = createLogger({ module: "gmail/parsers" });

// Dispatch table: gateway enum value → parser implementation.
// Bancolombia is intentionally absent — it has its own ingest path
// via parseBancolombiaEmail + processPendingBancolombiaReceipts.
const PARSERS: Record<string, { parse(html: string, opts?: { receivedAt?: Date }): ParseResult }> =
  {
    mercado_pago: mercadoPagoParser,
    payu: payuParser,
    wompi: wompiParser,
    apple: appleParser,
    paypal: paypalParser,
  };

/**
 * Parse a raw HTML email receipt for the given gateway.
 *
 * Returns:
 *   `parsed`       — fields extracted successfully; caller should persist them.
 *   `skipped`      — email is non-transactional (rejected, promo, etc.);
 *                    caller should set match_status='unmatched'.
 *   `needs_review` — parsing failed or parser is a stub; caller should leave
 *                    match_status='pending' and log for SLO alerting.
 *
 * This function never throws — all errors are caught and returned as
 * `needs_review`. Wrap internal parser errors are caught here as a
 * belt-and-suspenders layer on top of each parser's own try/catch.
 */
export function parseReceipt(
  gateway: GatewayId,
  rawHtml: string,
  opts?: { receivedAt?: Date },
): ParseResult {
  const parser = PARSERS[gateway];

  if (!parser) {
    log.warn({ gateway, event: "unknown_gateway" }, "no parser registered for gateway");
    return { kind: "needs_review", reason: "unknown_gateway" };
  }

  try {
    return parser.parse(rawHtml, opts);
  } catch (err) {
    log.error({ err, gateway, event: "parser_threw" }, "gateway parser threw unexpectedly");
    return { kind: "needs_review", reason: "parse_error" };
  }
}
