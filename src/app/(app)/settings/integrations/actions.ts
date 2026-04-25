"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { pullForUser } from "@/lib/gmail/pull";
import { createLogger } from "@/lib/logger";
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

  // Fire-and-forget: pull runs in the background; action returns immediately.
  // Best-effort trigger — if the Node process receives SIGTERM (deploy
  // rollover) between this return and the microtask running, the pull is
  // silently dropped. The 5-min cron in instrumentation.node.ts is the
  // reliable fallback.
  queueMicrotask(async () => {
    try {
      await pullForUser(session.id);
    } catch (err) {
      log.error(
        { err, userId: session.id, event: "incremental_pull_failed" },
        "background incremental pull threw",
      );
    }
  });

  log.info({ userId: session.id, event: "incremental_pull_triggered" }, "incremental pull queued");

  return { triggered: true };
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

  // Fire-and-forget — same SIGTERM caveat as triggerIncrementalPullAction.
  // The 5-min cron is the fallback for missed re-bootstraps.
  queueMicrotask(async () => {
    try {
      await pullForUser(session.id, { overrideSince });
    } catch (err) {
      log.error(
        { err, userId: session.id, event: "rebootstrap_pull_failed" },
        "background re-bootstrap pull threw",
      );
    }
  });

  log.info(
    { userId: session.id, overrideSince, event: "rebootstrap_triggered" },
    "re-bootstrap pull queued",
  );

  return { triggered: true };
}
