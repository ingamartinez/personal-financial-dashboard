// #812: opaque payment-gateway detection for classify-sweep.
//
// Some bank lines name the PAYMENT GATEWAY, not the underlying merchant —
// "MERCADOPAGO COLOMBIA", "MERCPAGO*PASARELAEMI", etc. The real counterparty
// is unknowable from the description alone: the same gateway line can front
// a completely different merchant every time. Confidently guessing a category
// here (as the AI did in #809's prod dry-run — 70-75 confidence, reasoning
// like "user history shows tech preference") is worse than `otros`, because
// the sweep's own prior-art pass would then treat the guess as evidence and
// propagate it forward. These rows must ABSTAIN, not guess.
//
// Scope is deliberately narrow: only gateways that are themselves opaque
// pass-throughs. Checked against `email_receipt_gateway`'s canonical values
// (see src/lib/db/schema.ts) rather than inventing new spellings — the
// `satisfies` below fails to compile if any of these ever stops being a
// member of that enum.
//
//   - mercado_pago, payu, wompi: genuinely opaque — the aggregator's own name
//     is what appears on the bank line, with no reliable merchant signal.
//   - bancolombia: the bank itself, not a pass-through intermediary.
//   - apple: Apple's own storefront (App Store / iTunes) — the counterparty
//     IS Apple, not obscured by Apple.
//   - paypal: not included — Findash has no confirmed evidence yet that
//     PayPal lines arrive merchant-less the way MercadoPago/PayU/Wompi do.
//     Revisit if prod evidence shows otherwise.
//   - arq: the user's own account/card provider, not a third-party gateway.
//
// A real merchant that merely transacts through one of these gateways but
// still NAMES itself in the description (e.g. "AMAZON MKTPLACE PMTS", #812's
// negative case) must NOT match — hence literal gateway-name patterns only,
// never a generic "payment processor" keyword.

import type { emailReceiptGateway } from "@/lib/db/schema";

type CanonicalGateway = (typeof emailReceiptGateway.enumValues)[number];

export const OPAQUE_GATEWAYS = [
  "mercado_pago",
  "payu",
  "wompi",
] as const satisfies readonly CanonicalGateway[];

export type OpaqueGateway = (typeof OPAQUE_GATEWAYS)[number] | "unknown_pasarela";

const OPAQUE_GATEWAY_PATTERNS: { gateway: (typeof OPAQUE_GATEWAYS)[number]; pattern: RegExp }[] = [
  // Covers "MERCADOPAGO COLOMBIA", "MERCADO PAGO LIMITAD", "MERCPAGO*PASARELAEMI",
  // "Mercado Pago*PASARELAE" (case-insensitive via the .toUpperCase() below).
  { gateway: "mercado_pago", pattern: /MERCADOPAGO|MERCADO\s+PAGO|MERCPAGO/ },
  { gateway: "payu", pattern: /\bPAYU\b/ },
  { gateway: "wompi", pattern: /\bWOMPI\b/ },
];

// "Pasarela" (Spanish for "gateway") shows up in shapes like
// "WOMPI*PASARELA..." or "MERCPAGO*PASARELAEMI" — a generic tell that the
// line names a payment gateway even for a processor not in our named list
// above. Checked only after the named patterns so a named match always wins.
//
// Unanchored substring matching would violate this module's own contract
// (see the "must NOT match" note above): "pasarela" is ordinary Spanish —
// a boutique, shoe shop or salon can plausibly be named "La Pasarela" or
// "Pasarela Fashion", and that tx would then abstain and vanish from every
// future sweep forever (candidateWhereClause excludes abstained rows
// permanently — see sweep.ts). Every observed real-world instance of this
// shape has "PASARELA" immediately after the merchant/gateway separator
// `*` (e.g. "MERCPAGO*PASARELAEMI", "ACME*PASARELA PAGOS`) — that position
// is required here so a normal merchant name never matches.
const GENERIC_PASARELA_PATTERN = /\*\s*PASARELA\b/;

/**
 * Check a transaction's description/merchant fields for a known-opaque
 * payment gateway. Returns the matched canonical gateway (or
 * "unknown_pasarela" for the generic fallback), or null if none matched —
 * callers fall through to prior-art/rule/AI classification as normal.
 *
 * Accepts multiple candidate strings (descriptionRaw, merchant) since the
 * parsed `merchant` field can sometimes carry the gateway name even when
 * descriptionRaw doesn't verbatim, or vice versa.
 */
export function matchOpaqueGateway(
  candidates: (string | null | undefined)[],
): OpaqueGateway | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const upper = candidate.toUpperCase();
    for (const { gateway, pattern } of OPAQUE_GATEWAY_PATTERNS) {
      if (pattern.test(upper)) return gateway;
    }
    if (GENERIC_PASARELA_PATTERN.test(upper)) return "unknown_pasarela";
  }
  return null;
}
