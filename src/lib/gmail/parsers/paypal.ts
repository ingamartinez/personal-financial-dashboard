// TODO: implement when prod samples available — see #453 follow-up
import { createLogger } from "@/lib/logger";
import type { GatewayParser, ParseResult } from "./types";

const log = createLogger({ module: "gmail/parsers/paypal" });

export const paypalParser: GatewayParser = {
  parse(_html: string, _opts?: { receivedAt?: Date }): ParseResult {
    log.info(
      { event: "paypal_parser_stub" },
      "PayPal parser is a stub — no prod samples available yet",
    );
    return { kind: "needs_review", reason: "paypal_parser_not_implemented" };
  },
};
