"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { createQueue } from "@/lib/queue";
import { createLogger } from "@/lib/logger";
import type { GmailPullJobData } from "@/lib/queue/workers/gmail-pull";
import type { SetBootstrapSinceDateResult, TriggerPullResult } from "./integrations-types";

const log = createLogger({ module: "settings-integrations-actions" });

export async function setBootstrapSinceDateAction(
  date: Date | null,
): Promise<SetBootstrapSinceDateResult> {
  const session = await getSessionUser();

  // Server-side clamp: future dates make Gmail's `after:` filter silently
  // return zero results. The picker disables future dates, but server actions
  // are a public surface — coerce future dates to null instead of trusting
  // the client.
  const safeDate = date && date > new Date() ? null : date;
  if (safeDate !== date) {
    log.warn(
      { userId: session.id, requested: date, event: "bootstrap_since_date_clamped" },
      "rejected future bootstrap_since_date, coerced to null",
    );
  }

  await db
    .update(gmailConnections)
    .set({ bootstrapSinceDate: safeDate, updatedAt: new Date() })
    .where(and(eq(gmailConnections.userId, session.id), notDeleted(gmailConnections.deletedAt)));

  log.info(
    { userId: session.id, bootstrapSinceDate: safeDate, event: "bootstrap_since_date_set" },
    "bootstrap_since_date updated",
  );

  return { ok: true };
}

export async function triggerIncrementalPullAction(): Promise<TriggerPullResult> {
  const session = await getSessionUser();

  // Enqueue a single-user gmail-pull job. More reliable than queueMicrotask:
  // the job persists in Redis even if SIGTERM arrives before execution, and
  // BullMQ will retry on transient failures. The 5-min cron is still the
  // reliable fallback for missed pulls (#593).
  const queue = createQueue<GmailPullJobData>("gmail-pull");
  const job = await queue.add(
    "gmail-pull",
    { mode: "single-user", userId: session.id },
    { jobId: `gmail-pull-user-${session.id}-${Date.now()}` },
  );

  log.info({ userId: session.id, event: "incremental_pull_triggered" }, "incremental pull queued");

  return { triggered: true, jobId: job.id ?? null };
}

export async function triggerRebootstrapAction(): Promise<TriggerPullResult> {
  const session = await getSessionUser();

  // Read the per-connection bootstrap window. Fall back to Jan 1 of current
  // year if the user hasn't set one explicitly (mirrors computeSinceDate logic).
  const [conn] = await db
    .select({ bootstrapSinceDate: gmailConnections.bootstrapSinceDate })
    .from(gmailConnections)
    .where(and(eq(gmailConnections.userId, session.id), notDeleted(gmailConnections.deletedAt)))
    .limit(1);

  const overrideSince: Date = conn?.bootstrapSinceDate ?? new Date(new Date().getFullYear(), 0, 1);

  // Enqueue a single-user re-bootstrap job. More reliable than queueMicrotask
  // — persists in Redis across SIGTERM, BullMQ retries on transient failures.
  const queue = createQueue<GmailPullJobData>("gmail-pull");
  const job = await queue.add(
    "gmail-pull",
    { mode: "single-user", userId: session.id, opts: { overrideSince } },
    { jobId: `gmail-pull-rebootstrap-${session.id}-${Date.now()}` },
  );

  log.info(
    { userId: session.id, overrideSince, event: "rebootstrap_triggered" },
    "re-bootstrap pull queued",
  );

  return { triggered: true, jobId: job.id ?? null };
}
