import type { ConsolidationReport } from "@/lib/ingestion/bancolombia-statement/consolidate";

// Returned by preview / commit actions. Single-sheet uploads (Visa, Amex
// nacional) yield a plain ConsolidationReport; multi-sheet uploads
// (Mastercard/Amex internacional = PESOS + DOLARES in one xlsx) yield a
// MultiConsolidationReport wrapping one report per sheet, keyed by account.
export type ConsolidateActionResult = ConsolidationReport | MultiConsolidationReport;

export type MultiConsolidationReport = {
  kind: "multi";
  reports: ConsolidationReport[];
};

export function isMultiReport(result: ConsolidateActionResult): result is MultiConsolidationReport {
  return (result as MultiConsolidationReport).kind === "multi";
}
