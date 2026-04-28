"use client";

import { Badge } from "@/components/ui/badge";
import type { IngestionKind } from "@/lib/ingestion/dispatch-types";

const labels: Record<IngestionKind, string> = {
  "arq-pdf": "ARQ PDF",
  "bancolombia-savings": "Movimientos",
  "bancolombia-extracto": "Extracto Mensual",
  "bancolombia-tc-legacy": "TC Legacy",
  "bancolombia-tc-detallado": "TC Detallado",
};

export function FormatBadge({ kind }: { kind: IngestionKind }) {
  return <Badge variant="secondary">{labels[kind]}</Badge>;
}
