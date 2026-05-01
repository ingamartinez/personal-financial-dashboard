/**
 * Heuristic merchant canonicalization.
 *
 * Collapses gateway-prefix fragmentation so downstream aggregation can group
 * the same merchant regardless of which payment provider processed the charge.
 * For example: `DLO*Didi` + `Didi` → both canonicalize to `Didi`.
 *
 * Rules (applied in order):
 *  1. null/undefined/blank → null
 *  2. Collapse internal whitespace
 *  3. Strip leading gateway prefix (DLO*, MERCADO PAGO*, PayPal*, …)
 *  4. Skip patterns tested against the (possibly-stripped) result → null
 *  5. Return trimmed result; if stripping left an empty string, return original
 *
 * Deterministic pure function — no DB lookups, no title-casing, no locale.
 */

// ---------------------------------------------------------------------------
// Skip patterns — merchant strings that represent internal events and should
// NOT be surfaced in aggregations. Case-insensitive.
// ---------------------------------------------------------------------------

const SKIP_PATTERNS: RegExp[] = [
  /^Pago TC \*\d+/i,
  /^Transferencia a cuenta \*\d+/i,
  /^Pago QR a llave \d+/i,
  /^AJUSTE/i,
  /^APORTES EN LINEA/i,
  /^TRANSFERENCIA CTA SUC/i,
];

// ---------------------------------------------------------------------------
// Gateway prefix patterns — leading substring that identifies the payment
// intermediary and should be stripped to surface the real merchant.
// Order matters: try each in sequence, first match wins.
//
// NOTE: `MERCADOPAGO\s+` is intentionally EXCLUDED. `MERCADOPAGO COLOMBIA`
// is an opaque gateway string that Gmail enrichment (Epic G) resolves — the
// heuristic cannot safely strip it without guessing the wrong merchant.
// ---------------------------------------------------------------------------

const GATEWAY_PREFIX_PATTERNS: RegExp[] = [
  /^DLO\*/i,
  /^MERCADO PAGO\*/i,
  /^Mercado Pago\*/i,
  /^PAYU[* ]/i,
  /^WOMPI[* ]/i,
  /^PayPal\*?/i,
];

/**
 * Canonicalize a raw merchant string by stripping gateway prefixes and
 * filtering out internal-transfer/adjustment strings.
 *
 * Returns null when:
 *  - input is null/undefined/blank
 *  - input matches a skip pattern (internal transfer, adjustment, etc.)
 */
export function canonicalizeMerchant(raw: string | null | undefined): string | null {
  // Step 1: null/undefined/blank guard
  if (raw == null || raw.trim() === "") return null;

  // Step 2: collapse internal whitespace
  const trimmed = raw.trim().replace(/\s+/g, " ");

  // Step 3: strip leading gateway prefix (try each in order, first match wins)
  let candidate = trimmed;
  for (const pattern of GATEWAY_PREFIX_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const stripped = trimmed.slice(match[0].length).trim();
      // If stripping left an empty string, fall back to original (don't lose data)
      candidate = stripped.length > 0 ? stripped : trimmed;
      break;
    }
  }

  // Step 4: skip patterns tested against the (possibly-stripped) candidate
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(candidate)) return null;
  }

  // Step 5: return the result
  return candidate;
}

/**
 * Convenience helper for INSERT sites that need both the raw merchant and
 * the canonical form in a single spread.
 *
 * Usage:
 *   .values({
 *     ...
 *     ...withCanonical(parsedMerchant),
 *     ...
 *   })
 */
export function withCanonical(raw: string | null | undefined): {
  merchant: string | null;
  canonicalMerchant: string | null;
} {
  // merchant: preserve the original trimmed string (raw storage for audit)
  // canonicalMerchant: apply full canonicalization (skip + prefix-strip)
  const m = raw != null && raw.trim() ? raw.trim() : null;
  return {
    merchant: m,
    canonicalMerchant: canonicalizeMerchant(raw),
  };
}
