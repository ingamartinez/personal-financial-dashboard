import { describe, expect, it } from "vitest";
import { GATEWAYS } from "@/lib/gmail/registry";
import { parseReceipt } from "./index";
import { jetsmartParser } from "./jetsmart";
import type { ParseResult } from "./types";

type EvidenceData = Extract<ParseResult, { kind: "evidence" }>["data"];
type EvidenceHasAmount = "amountCents" extends keyof EvidenceData ? true : false;
const evidenceHasAmount: EvidenceHasAmount = false;

function itineraryHtml(opts?: { total?: string; route?: string }): string {
  const total = opts?.total ?? "TOTAL: $85.211";
  const route = opts?.route ?? "BOG → MDE";
  return `<!DOCTYPE html><html><body>
    <p>Tu itinerario JetSmart</p>
    <p>${route}</p>
    <p>${total}</p>
  </body></html>`;
}

describe("jetsmartParser", () => {
  it("type-locks evidence data so amountCents cannot be added quietly", () => {
    expect(evidenceHasAmount).toBe(false);
  });

  it("returns evidence kind with merchant JetSmart and no amount", () => {
    const receivedAt = new Date("2026-01-05T22:42:00-05:00");
    const result = jetsmartParser.parse(itineraryHtml(), { receivedAt });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.data.merchant).toBe("JetSmart");
    expect(result.data.occurredAt).toEqual(receivedAt);
    expect("amountCents" in result.data).toBe(false);
    expect(result.data.extra).toEqual({ route: "BOG-MDE" });
  });

  it("does not extract a fare even when TOTAL is in the body", () => {
    const result = jetsmartParser.parse(itineraryHtml({ total: "TOTAL: $85211 COP" }));
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect("amountCents" in result.data).toBe(false);
    expect(JSON.stringify(result.data)).not.toMatch(/85211/);
  });
});

describe("evidence-mode parsers", () => {
  it("every evidence gateway parses as evidence kind without an amount", () => {
    const receivedAt = new Date("2026-01-05T22:42:00-05:00");
    const evidenceGateways = GATEWAYS.filter((g) => g.mode === "evidence");
    expect(evidenceGateways.length).toBeGreaterThan(0);
    for (const g of evidenceGateways) {
      const result = parseReceipt(g.id, itineraryHtml(), { receivedAt });
      expect(result.kind).toBe("evidence");
      if (result.kind === "evidence") {
        expect("amountCents" in result.data).toBe(false);
        expect(result.data.merchant.length).toBeGreaterThan(0);
      }
    }
  });
});
