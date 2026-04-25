import { createLogger } from "@/lib/logger";
import { extractVisibleText } from "./_text";
import type { GatewayParser, ParseResult } from "./types";

const log = createLogger({ module: "gmail/parsers/wompi" });

// Wompi emails use comma as thousands separator and no decimal places for COP
// amounts (e.g. "COP $137,000" = 137 000 COP = 13 700 000 cents).
// Decimal places (optional): "COP $1,234.56" would be 1234 COP + 56 cents.
//
// Reference field: prefer WC-XXXXXXXX-XXXXXXXXXX over the Transacción# line.
// The WC- reference is stable and matches the payment provider's identifier.
//
// occurredAt: Wompi emails do not include a date in the body — we use
// opts.receivedAt (Gmail internalDate) as a reliable stand-in.

function parseCopAmount(intPart: string, decPart?: string): bigint {
  // Remove comma thousands separators → integer COP value
  const cop = BigInt(intPart.replace(/,/g, ""));
  const cents = cop * BigInt(100);
  if (decPart) {
    // Only 2 decimal digits expected
    const dec = BigInt(decPart.padEnd(2, "0").slice(0, 2));
    return cents + dec;
  }
  return cents;
}

export const wompiParser: GatewayParser = {
  parse(html: string, opts?: { receivedAt?: Date }): ParseResult {
    try {
      const text = extractVisibleText(html);

      // Only process approved transactions
      if (!/APROBADA/i.test(text)) {
        return { kind: "skipped", reason: "not_approved" };
      }

      // Extract merchant: between "pago realizado a " and " y el dinero"
      const merchantMatch = text.match(/pago\s+realizado\s+a\s+(.+?)\s+y\s+el\s+dinero/i);
      if (!merchantMatch) {
        log.warn(
          { event: "wompi_merchant_not_found" },
          "could not extract merchant from Wompi email",
        );
        return { kind: "needs_review", reason: "merchant_not_found" };
      }
      const merchant = merchantMatch[1].trim();

      // Extract reference: prefer WC- prefixed reference
      const refMatch = text.match(/Referencia:\s*(WC-[\d-]+)/i);
      const referenceId = refMatch ? refMatch[1] : null;

      // Extract amount: "Monto: COP $137,000" or "Monto: COP $1,234.56"
      const amountMatch = text.match(/Monto:\s*(?:COP\s*)?\$\s*([\d,]+)(?:\.(\d{2}))?/i);
      if (!amountMatch) {
        log.warn({ event: "wompi_amount_not_found" }, "could not extract amount from Wompi email");
        return { kind: "needs_review", reason: "amount_not_found" };
      }
      const amountCents = parseCopAmount(amountMatch[1], amountMatch[2]);

      // Currency: Wompi Colombia-only; USD support stubbed for completeness
      const currency: "COP" | "USD" = /USD/i.test(text) ? "USD" : "COP";

      // occurredAt: not in body — use email received date (required; no wall-clock fallback)
      if (!opts?.receivedAt) {
        return { kind: "needs_review", reason: "missing_occurred_at" };
      }
      const occurredAt = opts.receivedAt;

      return {
        kind: "parsed",
        data: { merchant, amountCents, currency, occurredAt, referenceId },
      };
    } catch (err) {
      log.error({ err, event: "wompi_parse_error" }, "unexpected error parsing Wompi email");
      return { kind: "needs_review", reason: "parse_error" };
    }
  },
};
