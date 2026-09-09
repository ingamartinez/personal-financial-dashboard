import { createLogger } from "@/lib/logger";
import { extractVisibleText } from "./_text";
import type { GatewayParser, ParseResult } from "./types";

const log = createLogger({ module: "gmail/parsers/jetsmart" });

// JetSmart itineraries are evidence, not receipts. The fare in the body is
// not the card leg the bank posts, so this parser never extracts an amount
// — even when the HTML contains TOTAL / $ / COP. Correlation for these
// rows is time-only (#814 PR5).

export const jetsmartParser: GatewayParser = {
  parse(html: string, opts?: { receivedAt?: Date; subject?: string }): ParseResult {
    try {
      const text = extractVisibleText(html);
      const extra: Record<string, unknown> = {};
      const routeMatch = text.match(/\b([A-Z]{3})\s*(?:→|->|–|—)\s*([A-Z]{3})\b/);
      if (routeMatch) extra.route = `${routeMatch[1]}-${routeMatch[2]}`;
      if (opts?.subject) extra.subject = opts.subject.slice(0, 200);

      return {
        kind: "evidence",
        data: {
          merchant: "JetSmart",
          occurredAt: opts?.receivedAt ?? null,
          referenceId: null,
          ...(Object.keys(extra).length > 0 ? { extra } : {}),
        },
      };
    } catch (err) {
      log.error({ err, event: "jetsmart_parse_threw" }, "jetsmart parser threw");
      return { kind: "needs_review", reason: "parse_error" };
    }
  },
};
