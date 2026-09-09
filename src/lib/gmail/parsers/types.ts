export interface ParsedReceipt {
  merchant: string;
  amountCents: bigint;
  currency: "COP" | "USD";
  occurredAt: Date;
  referenceId: string | null;
  extra?: Record<string, unknown>;
}

// Evidence-mode parse: merchant (and optional extras) for the correlator /
// AI bundle. No amountCents field — itineraries are not the card leg, and
// adding one here is a type error so a later parser cannot quietly start
// extracting fares onto the amount-match path.
export interface ParsedEvidence {
  merchant: string;
  occurredAt: Date | null;
  referenceId: string | null;
  extra?: Record<string, unknown>;
}

export type ParseResult =
  | { kind: "parsed"; data: ParsedReceipt }
  | { kind: "evidence"; data: ParsedEvidence }
  | { kind: "skipped"; reason: string }
  | { kind: "needs_review"; reason: string };

export interface GatewayParser {
  parse(html: string, opts?: { receivedAt?: Date; subject?: string }): ParseResult;
}
