import {
  matchBancolombiaVariant,
  parseBancolombiaAmount,
  parseBancolombiaDate,
  UNIVERSAL_SKIP_PATTERNS,
  type BancolombiaParseResult,
  type NeedsReviewBancolombiaMessage,
  type ParsedBancolombiaTx,
  type ParsedBancolombiaTxBase,
  type SkippedBancolombiaMessage,
  type SkipReason,
} from "@/lib/ingestion/bancolombia-variants";

// The SMS parser is a thin wrapper around the shared bancolombia-variants
// matcher. The only SMS-specific logic is the skip-pattern list below —
// notifications that Bancolombia sends as SMS but not (always) as email,
// plus patterns like "tus gastos" that are SMS-safe but collide with the
// marketing footer of transactional emails and MUST NOT be applied there.

// Back-compat re-exports. Many callers still import the legacy names.
export type ParsedSmsBase = ParsedBancolombiaTxBase;
export type ParsedSms = ParsedBancolombiaTx;
export type SkippedSms = SkippedBancolombiaMessage;
export type NeedsReviewSms = NeedsReviewBancolombiaMessage;
export type ParseResult = BancolombiaParseResult;
export { parseBancolombiaAmount as parseSmsAmount, parseBancolombiaDate as parseSmsDate };
export {
  resolveAccountFromLast4,
  type RoutableAccount,
} from "@/lib/ingestion/bancolombia-variants";

const SMS_EXTERNAL_ID_PREFIX = "bcol-sms";

// SMS-only skip patterns — these strings ALSO appear in the marketing footer
// of transactional Bancolombia emails ("Controla tus gastos", etc.), so they
// cannot be applied there. Everything that is universal (failures, account
// info updates, login notifications) lives in UNIVERSAL_SKIP_PATTERNS.
const SMS_ONLY_SKIP_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: SkipReason }> = [
  { pattern: /tu\s+calendario/i, reason: "non_transactional" },
  { pattern: /tus\s+gastos\b/i, reason: "non_transactional" },
];

const SMS_SKIP_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: SkipReason }> = [
  ...UNIVERSAL_SKIP_PATTERNS,
  ...SMS_ONLY_SKIP_PATTERNS,
];

function detectSmsSkip(body: string): SkippedSms["reason"] | null {
  for (const { pattern, reason } of SMS_SKIP_PATTERNS) {
    if (pattern.test(body)) return reason;
  }
  return null;
}

export function parseSmsBancolombia(body: string): ParseResult {
  const raw = body.trim();

  const skip = detectSmsSkip(raw);
  if (skip) return { kind: "skip", reason: skip, raw };

  const matched = matchBancolombiaVariant(raw, { externalIdPrefix: SMS_EXTERNAL_ID_PREFIX });
  if (matched) return matched;

  return { kind: "needs_review", reason: "unknown_pattern", raw };
}
