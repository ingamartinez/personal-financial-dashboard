"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { ingestionLogs } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { ingestParsed } from "@/lib/ingestion/sms-pipeline";
import { parseSmsBancolombia } from "@/lib/ingestion/sms-bancolombia";

const retrySchema = z.object({
  logId: z.number().int().positive(),
  accountId: z.number().int().positive(),
});

const dismissSchema = z.object({
  logId: z.number().int().positive(),
});

export type InboxActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * Re-run the ingest pipeline for a previously-errored log using an account the
 * user picked. On success, links `resolved_txn_id`; on failure, still marks the
 * log resolved so the inbox is auditable — the raw payload stays intact either way.
 * Idempotent: once `resolved_at` is set, the row cannot be re-processed.
 */
export async function retryIngestLog(
  input: z.input<typeof retrySchema>,
): Promise<InboxActionResult> {
  const session = await getSessionUser();
  const parsed = retrySchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  const [log] = await db
    .select({
      id: ingestionLogs.id,
      userId: ingestionLogs.userId,
      source: ingestionLogs.source,
      status: ingestionLogs.status,
      payload: ingestionLogs.payload,
      resolvedAt: ingestionLogs.resolvedAt,
    })
    .from(ingestionLogs)
    .where(and(eq(ingestionLogs.id, parsed.data.logId), eq(ingestionLogs.userId, session.id)));

  if (!log) return { status: "error", message: "Log no encontrado." };
  if (log.status !== "error") {
    return { status: "error", message: "Este log no está en estado error." };
  }
  if (log.resolvedAt) {
    return { status: "error", message: "Este log ya fue resuelto." };
  }
  if (log.source !== "sms") {
    return {
      status: "error",
      message: `Retry para source='${log.source}' todavía no está implementado.`,
    };
  }

  const payload = log.payload as { body?: unknown } | null;
  const body = typeof payload?.body === "string" ? payload.body : null;
  if (!body) {
    return { status: "error", message: "Payload sin body — no se puede re-parsear." };
  }

  const reparsed = parseSmsBancolombia(body);
  const outcome = await ingestParsed(session.id, reparsed, {
    forceAccountId: parsed.data.accountId,
  });

  const now = new Date();
  if (outcome.status === "inserted") {
    await db
      .update(ingestionLogs)
      .set({
        resolvedAt: now,
        resolvedTxnId: outcome.txId,
        resolution: "retried_success",
      })
      .where(and(eq(ingestionLogs.id, log.id), isNull(ingestionLogs.resolvedAt)));
    revalidatePath("/settings/inbox");
    return { status: "ok" };
  }

  // duplicated / skipped / error → log the attempt and surface the reason.
  const reason =
    outcome.status === "duplicated"
      ? "Transacción ya existía (duplicado)"
      : outcome.status === "skipped"
        ? `Skipped: ${outcome.reason}`
        : outcome.reason;

  await db
    .update(ingestionLogs)
    .set({
      resolvedAt: now,
      resolution: "retried_failed",
      errorMessage: reason,
    })
    .where(and(eq(ingestionLogs.id, log.id), isNull(ingestionLogs.resolvedAt)));

  revalidatePath("/settings/inbox");
  return { status: "error", message: reason };
}

/**
 * Mark an errored log as intentionally dismissed (not a bug, not recoverable,
 * user acknowledged). Keeps the row for audit trail.
 */
export async function dismissIngestLog(
  input: z.input<typeof dismissSchema>,
): Promise<InboxActionResult> {
  const session = await getSessionUser();
  const parsed = dismissSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  const result = await db
    .update(ingestionLogs)
    .set({ resolvedAt: new Date(), resolution: "dismissed" })
    .where(
      and(
        eq(ingestionLogs.id, parsed.data.logId),
        eq(ingestionLogs.userId, session.id),
        eq(ingestionLogs.status, "error"),
        isNull(ingestionLogs.resolvedAt),
      ),
    )
    .returning({ id: ingestionLogs.id });

  if (result.length === 0) {
    return { status: "error", message: "Log no encontrado, ya resuelto, o no está en error." };
  }

  revalidatePath("/settings/inbox");
  return { status: "ok" };
}
