// Shared HTML-to-visible-text helper for gateway email parsers.
//
// WHY THIS EXISTS
// ---------------
// CodeQL `js/double-escaping` was triggered in payu.ts by a cascading
// named-entity replacement chain where &amp; was decoded AFTER other
// replacements — creating a double-decode path:
//   "&amp;amp;" → "&amp;" → "&"   (input that was meant to stay "&amp;")
// The fix is a single-pass atomic lookup so each &NAME; is matched exactly
// once and cannot cascade.
//
// Note: bancolombia.ts keeps its own private implementation (copied here from
// the same pattern) to limit the blast radius of issue #453. That parser has
// a different return type (BancolombiaParseResult) and extra helpers
// (isolateTransactionalSentence) that make a shared import non-trivial to
// wire safely. Unifying them is deferred.

// Named HTML entities that appear in real gateway emails (PayU, Wompi,
// MercadoPago, Apple). This is the union of all entity sets observed across
// the four parsers. Keep `amp`, `lt`, `gt` ONLY in this lookup — they must
// not appear as standalone sequential `.replace()` calls (the double-escape
// risk). Adding an entity here is always safe; the replacer is a pure lookup
// with no cascading.
const NAMED_ENTITIES: Record<string, string> = {
  // Whitespace
  nbsp: " ",
  // Structural (must live here, not as sequential replace calls)
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Zero-width non-joiner (Mercado Pago emails)
  zwnj: "",
  // Degree sign — critical for "N.° de operación" in Mercado Pago reference extraction
  deg: "°",
  // Dashes (Wompi footer)
  mdash: "—",
  ndash: "–",
  // Spanish accents (lowercase)
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  // Spanish accents (uppercase)
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  // Additional accented vowels
  uuml: "ü",
  Uuml: "Ü",
  // Punctuation used in Spanish text
  iexcl: "¡",
  iquest: "¿",
  // Smart quotes and ellipsis — ARQ emails use &rsquo; in "We&rsquo;ve debited"
  // which breaks DEBITED_RE when left undecoded. See issue #641.
  rsquo: "’", // ' right single quotation mark
  lsquo: "‘", // ' left single quotation mark
  rdquo: "”", // " right double quotation mark
  ldquo: "“", // " left double quotation mark
  hellip: "…", // … horizontal ellipsis
};

/**
 * Decode HTML character references in a string — single-pass, safe from
 * CodeQL `js/double-escaping`.
 *
 * The named-entity pass uses a single regex `/&([A-Za-z]+);/g` with a
 * lookup-table replacer so each `&NAME;` is matched exactly once and the
 * replacement value is never re-scanned. This is the pattern CodeQL accepts
 * (same as bancolombia.ts:91-102).
 */
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

/**
 * Strip HTML tags and decode entities to produce the visible text of an email.
 *
 * Processing order (important — do NOT reorder):
 *   1. Strip <style> blocks  — prevent CSS from leaking into text
 *   2. Strip <script> blocks — prevent JS from leaking into text
 *   3. Strip HTML comments
 *   4. Strip all remaining tags
 *   5. Replace literal non-breaking space (U+00A0) — Apple emails embed \xa0
 *   6. Decode HTML entities (single-pass, CodeQL-safe)
 *   7. Collapse whitespace
 *
 * Closing-tag patterns use `<\/tag[^>]*>` (per CodeQL `js/bad-tag-filter`
 * remediation) so browser-lenient variants like `</script >`, `</style\t>`,
 * or the bogus-content form `</script foo>` are also consumed. A narrower
 * `<\/script>` would leak script contents into the extracted text.
 */
export function extractVisibleText(rawHtml: string): string {
  let t = rawHtml;
  // Step 1-2: Remove block-level content that must never appear in visible text.
  // CodeQL js/bad-tag-filter: closing tag pattern is `<\/tag[^>]*>` not `<\/tag>`.
  t = t.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ");
  t = t.replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ");
  // Step 3: Remove HTML comments.
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  // Step 4: Strip all remaining tags.
  t = t.replace(/<[^>]+>/g, " ");
  // Step 5: Normalise literal non-breaking spaces (Apple emails).
  t = t.replace(/ /g, " ");
  // Step 6: Decode HTML entities — single-pass atomic lookup (CodeQL js/double-escaping safe).
  t = decodeHtmlEntities(t);
  // Step 7: Collapse all whitespace and trim.
  t = t.replace(/\s+/g, " ").trim();
  return t;
}
