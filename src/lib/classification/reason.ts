import type { ClassificationReasonJson } from "@/lib/db/schema";

export type { ClassificationReasonJson };
export type AbstainReasonKind = "opaque_gateway" | "probable_transfer_pair";

export function asReason(value: unknown): ClassificationReasonJson | null {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as ClassificationReasonJson;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ClassificationReasonJson;
      }
      return { text: value };
    } catch {
      return { text: value };
    }
  }
  return null;
}

export function sweptReason(): ClassificationReasonJson {
  return { action: "swept", run: new Date().toISOString() };
}

export function abstainReason(
  reason: AbstainReasonKind,
  extra: Record<string, unknown> = {},
): ClassificationReasonJson {
  return { action: "abstained", reason, ...extra };
}

export function priorArtReason(
  categorySlug: string,
  evidence: { manualCount: number; totalCount: number },
): ClassificationReasonJson {
  return {
    action: "prior_art",
    categorySlug,
    manualCount: evidence.manualCount,
    totalCount: evidence.totalCount,
  };
}

export function aiReasonText(reason: ClassificationReasonJson | null): string | null {
  if (!reason) return null;
  if (typeof reason.aiReason === "string" && reason.aiReason.length > 0) return reason.aiReason;
  if (typeof reason.text === "string" && reason.text.length > 0) return reason.text;
  if (typeof reason.reason === "string" && reason.reason.length > 0 && !reason.action) {
    return reason.reason;
  }
  return null;
}

export function receiptIdFromReason(reason: ClassificationReasonJson | null): number | null {
  if (!reason) return null;
  if (typeof reason.receiptId === "number" && Number.isFinite(reason.receiptId)) {
    return reason.receiptId;
  }
  if (Array.isArray(reason.receiptIds) && typeof reason.receiptIds[0] === "number") {
    return reason.receiptIds[0];
  }
  return null;
}
