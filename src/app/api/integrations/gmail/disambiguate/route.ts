import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { applyEnrichment } from "@/lib/gmail/enrich";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/disambiguate" });

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

  // decision === "reject": remove transactionId from match_candidates of every
  // ambiguous receipt that still lists it. If the resulting array becomes
  // empty, flip match_status to 'unmatched'.
  try {
    // Fetch all ambiguous receipts referencing this tx (scoped to user).
    const candidates = await db
      .select({ id: emailReceipts.id, matchCandidates: emailReceipts.matchCandidates })
      .from(emailReceipts)
      .where(
        and(
          eq(emailReceipts.userId, userId),
          eq(emailReceipts.matchStatus, "ambiguous"),
          notDeleted(emailReceipts.deletedAt),
          sql`${emailReceipts.matchCandidates} @> ${JSON.stringify([transactionId])}::jsonb`,
        ),
      );

    for (const row of candidates) {
      const remaining = (row.matchCandidates ?? []).filter((id) => id !== transactionId);
      await db
        .update(emailReceipts)
        .set({
          matchCandidates: remaining.length > 0 ? remaining : [],
          matchStatus: remaining.length === 0 ? "unmatched" : "ambiguous",
          updatedAt: new Date(),
        })
        .where(and(eq(emailReceipts.id, row.id), eq(emailReceipts.userId, userId)));
    }

    log.info(
      { userId, transactionId, count: candidates.length, event: "disambiguate_rejected" },
      "disambiguation rejected — candidates released",
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error(
      { err, userId, transactionId, event: "disambiguate_reject_failed" },
      "failed to process rejection during disambiguation",
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
