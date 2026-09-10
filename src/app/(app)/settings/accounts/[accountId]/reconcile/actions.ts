"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { recordReconciliationDecision } from "@/lib/reconciliation/commit";

const reviewSchema = z.object({
  txnId: z.coerce.number().int().positive(),
  action: z.enum(["archived", "kept", "merged_into"]),
  mergedIntoTxnId: z.coerce.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

export type ReviewReconciliationInput = z.infer<typeof reviewSchema>;

export async function reviewReconciliationDecision(input: ReviewReconciliationInput) {
  const session = await getSessionUser();
  const parsed = reviewSchema.parse(input);
  await recordReconciliationDecision({
    userId: session.id,
    txnId: parsed.txnId,
    action: parsed.action,
    mergedIntoTxnId: parsed.mergedIntoTxnId,
    note: parsed.note,
  });
  revalidatePath("/transactions");
  return { ok: true as const };
}
