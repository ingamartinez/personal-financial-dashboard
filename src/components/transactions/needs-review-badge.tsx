"use client";

import { useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DisambiguationDialog } from "./disambiguation-dialog";
import type { GmailAmbiguousReceipt } from "@/lib/types";

export type NeedsReviewBadgeProps = {
  receipts: GmailAmbiguousReceipt[];
  transactionId: number;
  txDescription: string;
  txAmountCents: string;
  txOccurredAt: string;
};

/**
 * #455 (Epic G): badge rendered on tx rows that have ≥1 ambiguous Gmail
 * receipt candidate. Clicking opens the DisambiguationDialog.
 *
 * Visual style mirrors the low-confidence badge in confidence-badge.tsx
 * (rose tones, outline variant, small AlertTriangle).
 */
export function NeedsReviewBadge({
  receipts,
  transactionId,
  txDescription,
  txAmountCents,
  txOccurredAt,
}: NeedsReviewBadgeProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex cursor-pointer items-center"
        aria-label="Email enrichment available — multiple candidates"
        title="Email enrichment available — multiple candidates"
      >
        <Badge
          variant="outline"
          className="gap-1 border-rose-300 bg-rose-50 font-normal text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
          asChild={false}
        >
          <AlertTriangleIcon className="size-3" />
          revisar
        </Badge>
      </button>

      <DisambiguationDialog
        open={open}
        onOpenChange={setOpen}
        receipts={receipts}
        transactionId={transactionId}
        txDescription={txDescription}
        txAmountCents={txAmountCents}
        txOccurredAt={txOccurredAt}
      />
    </>
  );
}
