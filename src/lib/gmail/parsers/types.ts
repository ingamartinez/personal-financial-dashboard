export interface ParsedReceipt {
  merchant: string;
  amountCents: bigint;
  currency: "COP" | "USD";
  occurredAt: Date;
  referenceId: string | null;
}

export type ParseResult =
  | { kind: "parsed"; data: ParsedReceipt }
  | { kind: "skipped"; reason: string }
  | { kind: "needs_review"; reason: string };

export interface GatewayParser {
  parse(html: string, opts?: { receivedAt?: Date }): ParseResult;
}
