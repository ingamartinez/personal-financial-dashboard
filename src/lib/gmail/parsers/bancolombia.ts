import {
  matchBancolombiaVariant,
  UNIVERSAL_SKIP_PATTERNS,
  type BancolombiaParseResult,
  type SkipReason,
} from "@/lib/ingestion/bancolombia-variants";

// Email-side entry point into the shared Bancolombia variant matcher. The
// visible body of a Bancolombia notification email is word-for-word identical
// to the SMS body — which is why the shared matcher works for both.
//
// Two things differ from the SMS path:
// 1. Skip patterns: SMS skips on substrings like "tus gastos" that ALSO
//    appear in the marketing footer of transactional emails. Reusing the
//    SMS list would false-positive-skip legitimate purchase notifications.
//    Email needs its own (short, email-specific) skip list.
// 2. externalId prefix: `bcol-email` keeps (account_id, external_id)
//    uniqueness disjoint from the SMS path so re-parsing an email does not
//    collide with an already-ingested SMS tx covering the same event.
//    Cross-source dedup of the same underlying event happens at the
//    application layer (A+ dedup in ingestParsedEmail).

const EMAIL_EXTERNAL_ID_PREFIX = "bcol-email";

// Email-specific skip patterns. These are notifications that Bancolombia
// sends via email but not via SMS (monthly statement notice from the
// extractos.documentosbancolombia.com domain). Patterns that are universal
// across SMS+Email (failures, login notifications, etc.) live in
// UNIVERSAL_SKIP_PATTERNS in the shared variants module.
const EMAIL_ONLY_SKIP_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: SkipReason }> = [
  { pattern: /¡?\s*toc-toc\s*!/i, reason: "statement_notification" },
  { pattern: /ya\s+est[aá]\s+disponible\s+tu\s+extracto/i, reason: "statement_notification" },
  { pattern: /extracto\s+para\s+el\s+producto/i, reason: "statement_notification" },
];

const EMAIL_SKIP_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: SkipReason }> = [
  ...UNIVERSAL_SKIP_PATTERNS,
  ...EMAIL_ONLY_SKIP_PATTERNS,
];

function detectEmailSkip(body: string): SkipReason | null {
  for (const { pattern, reason } of EMAIL_SKIP_PATTERNS) {
    if (pattern.test(body)) return reason;
  }
  return null;
}

// -----------------------------------------------------------------------------
// HTML → visible-text extraction
//
// Bancolombia emails embed the transactional sentence ("Bancolombia:
// Compraste ... con tu T.Cred *NNNN, el DATE a las TIME") inside a table-based
// HTML scaffold with <style>, <script>, comments, and lots of nested tags.
// The shared variant matcher runs against the plain text of the body, so we
// need a lightweight HTML→text pipeline here.
//
// We intentionally avoid pulling in a full HTML parser (cheerio/jsdom) — the
// Bancolombia emails are machine-generated and consistently structured, and
// the regex strip+decode path is ~2 orders of magnitude faster than a DOM
// parse.
// -----------------------------------------------------------------------------

// Named HTML entities that appear in real Bancolombia emails. Spanish accents
// are usually emitted as UTF-8 in practice, but the named variants are a
// cheap defensive fallback against template changes.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  iexcl: "¡",
  iquest: "¿",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  ntilde: "ñ",
  Ntilde: "Ñ",
  uuml: "ü",
  Uuml: "Ü",
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

export function extractVisibleText(rawHtml: string): string {
  let t = rawHtml;
  // `\s*` on the closing tag lets us drop tags like `</script >` and
  // `</style\t>` which the HTML spec permits and which a naive `</script>`
  // regex would leave behind — flagged by CodeQL `js/bad-tag-filter` as a
  // stored-XSS vector if the extracted text is ever re-rendered elsewhere.
  t = t.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
  t = t.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeHtmlEntities(t);
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

// -----------------------------------------------------------------------------
// Email parser entry point
// -----------------------------------------------------------------------------

// Bancolombia transactional emails embed the transactional sentence
// ("Bancolombia: Compraste ...") inside a preamble + marketing footer. The
// shared variant matcher was designed for SMS (short bodies, no preamble),
// so some regexes — notably TC_CREDIT_RECEIVED with its leading `(.+?)` —
// over-capture the preamble when run on the full email text. Isolating the
// transactional sentence at the "Bancolombia:" marker prevents that.
function isolateTransactionalSentence(text: string): string {
  const m = text.match(/Bancolombia:\s*/i);
  if (!m || m.index === undefined) return text;
  return text.slice(m.index);
}

export function parseBancolombiaEmail(rawHtml: string): BancolombiaParseResult {
  const fullText = extractVisibleText(rawHtml);

  const skip = detectEmailSkip(fullText);
  if (skip) return { kind: "skip", reason: skip, raw: fullText };

  const transactional = isolateTransactionalSentence(fullText);
  const matched = matchBancolombiaVariant(transactional, {
    externalIdPrefix: EMAIL_EXTERNAL_ID_PREFIX,
  });
  if (matched) return matched;

  return { kind: "needs_review", reason: "unknown_pattern", raw: fullText };
}
