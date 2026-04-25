import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { applyEnrichment } from "@/lib/gmail/enrich";
import { applyRejection } from "@/lib/gmail/disambiguate";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/disambiguate-route" });

const bodySchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("confirm"),
    transactionId: z.number().int().positive(),
    receiptId: z.number().int().positive(),
  }),
  z.object({
    decision: z.literal("reject"),
    transactionId: z.number().int().positive(),
    receiptId: z.number().int().positive().optional(),
  }),
]);

export async function POST(request: Request) {
  const user = await getSessionUserOrNull();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await request.json();
    body = bodySchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { transactionId, decision } = body;
  const userId = user.id;

  if (decision === "confirm") {
    const { receiptId } = body;

    // applyEnrichment verifies tenant isolation internally and throws
    // "cross-tenant attempt" on mismatch.
    try {
      await applyEnrichment(userId, transactionId, receiptId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("cross-tenant attempt")) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      log.error(
        { err, userId, transactionId, receiptId, event: "disambiguate_confirm_failed" },
        "failed to apply enrichment during disambiguation",
      );
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    // Mark all OTHER ambiguous receipts that listed this tx as a candidate
    // as unmatched — the user picked one, the others were wrong matches.
    // We do this in a best-effort update after the main enrichment transaction
    // commits (losing candidates don't need to be atomic with the enrichment).
    try {
      await db
        .update(emailReceipts)
        .set({ matchStatus: "unmatched", updatedAt: new Date() })
        .where(
          and(
            eq(emailReceipts.userId, userId),
            eq(emailReceipts.matchStatus, "ambiguous"),
            notDeleted(emailReceipts.deletedAt),
            // NOT the receipt we just confirmed
            sql`${emailReceipts.id} != ${receiptId}`,
            // Still references this transactionId as a candidate
            sql`${emailReceipts.matchCandidates} @> ${JSON.stringify([transactionId])}::jsonb`,
          ),
        );
    } catch (err) {
      // Non-fatal: the enrichment already committed; log and continue.
      log.warn(
        { err, userId, transactionId, receiptId, event: "disambiguate_cleanup_failed" },
        "best-effort cleanup of losing candidates failed",
      );
    }

    log.info(
      { userId, transactionId, receiptId, event: "disambiguate_confirmed" },
      "disambiguation confirmed",
    );
    return NextResponse.json({ ok: true });
  }

  // decision === "reject": delegate to applyRejection service.
  try {
    await applyRejection(userId, transactionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error(
      { err, userId, transactionId, event: "disambiguate_reject_failed" },
      "failed to process rejection during disambiguation",
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
