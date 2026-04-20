import { AlertTriangleIcon, SparklesIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ClassificationMethod } from "@/lib/types";

export const CONFIDENCE_HIGH_THRESHOLD = 90;
export const CONFIDENCE_LOW_THRESHOLD = 60;

export type ConfidenceBand = "high" | "medium" | "low";

export function confidenceBand(
  method: ClassificationMethod,
  confidence: number | null,
): ConfidenceBand | null {
  if (method !== "rule" && method !== "ai") return null;
  if (confidence === null) return null;
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return "high";
  if (confidence >= CONFIDENCE_LOW_THRESHOLD) return "medium";
  return "low";
}

export function ConfidenceBadge({
  method,
  confidence,
}: {
  method: ClassificationMethod;
  confidence: number | null;
}) {
  const band = confidenceBand(method, confidence);
  if (band === null || band === "high") return null;
  const pct = Math.round(confidence ?? 0);
  if (band === "medium") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-amber-300 bg-amber-50 font-normal text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        title={`Auto-clasificado con confianza ${pct}%. Revisá o re-categorizá si hace falta.`}
      >
        <SparklesIcon className="size-3" />
        {pct}%
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 border-rose-300 bg-rose-50 font-normal text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
      title={`Clasificación con baja confianza (${pct}%). Revisá la sugerencia en el inbox.`}
    >
      <AlertTriangleIcon className="size-3" />
      revisar
    </Badge>
  );
}
