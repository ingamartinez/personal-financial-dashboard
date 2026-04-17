import type { ParsedSms } from "@/lib/ingestion/sms-bancolombia";

export type AliasKind = "qr" | "breb" | "account" | "name";

export type KeyForKind = {
  kind: AliasKind;
  value: string;
  initialDisplayName: string;
};

/**
 * Normalizes a sender name so small whitespace/case variations from Bancolombia
 * do not cause duplicate name-aliases for the same person.
 */
export function normalizeName(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Derives the (alias.kind, alias.value) key a given parsed SMS matched against
 * at ingest. The split action reuses this to reassign historical transactions
 * to a newly-extracted counterparty with 1:1 fidelity to the original match.
 */
export function keyForParsed(parsed: ParsedSms): KeyForKind | null {
  switch (parsed.kind) {
    case "qr_payment":
      return {
        kind: "qr",
        value: parsed.toKey,
        initialDisplayName: parsed.toKey,
      };
    case "bre_b_transfer":
      return {
        kind: "breb",
        value: parsed.toKey,
        initialDisplayName: parsed.recipientName,
      };
    case "transfer_sent":
      return {
        kind: "account",
        value: parsed.toAccount,
        initialDisplayName: `Cuenta *${parsed.toAccount}`,
      };
    case "transfer_received":
      return {
        kind: "name",
        value: normalizeName(parsed.senderName),
        initialDisplayName: parsed.senderName,
      };
    default:
      return null;
  }
}
