"use server";

// #633: Server actions for learning proposal lifecycle.
// Tenant-safe: userId ALWAYS from getSessionUser(), never from caller input.

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  recurringProposals,
  recurringTransactions,
  recurringLinkObservations,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";
import type { ProposalActionResult, ProposalActionInput } from "./learning-types";
import { proposalIdSchema } from "./learning-types";

const log = createLogger({ module: "settings/recurring/learning/actions" });

/**
 * Accept a proposal:
 *   - amount_update: updates recurring.amount_cents to the proposed value.
 *   - variable_flag: sets recurring.amount_type = 'variable'.
 * In both cases, marks the proposal as 'accepted' and marks linked observations as applied=true.
 * Atomic — runs in a single DB transaction.
 */
export async function acceptProposal(input: ProposalActionInput): Promise<ProposalActionResult> {
  const session = await getSessionUser();
  const parsed = proposalIdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Input inválido" };
  }
  const { proposalId } = parsed.data;

  try {
    await db.transaction(async (trx) => {
      // 1. Fetch the proposal — tenant-safe.
      const [proposal] = await trx
        .select({
          id: recurringProposals.id,
          recurringId: recurringProposals.recurringId,
          proposalType: recurringProposals.proposalType,
          payload: recurringProposals.payload,
          status: recurringProposals.status,
        })
        .from(recurringProposals)
        .where(
          and(eq(recurringProposals.userId, session.id), eq(recurringProposals.id, proposalId)),
        )
        .limit(1);

      if (!proposal) throw new Error("Propuesta no encontrada");
      if (proposal.status !== "pending") {
        throw new Error(`Propuesta ya ${proposal.status} — no se puede modificar`);
      }

      // 2. Apply the change to the recurring.
      if (proposal.proposalType === "amount_update") {
        const p = proposal.payload as { newAmountCents: string };
        if (!p.newAmountCents) throw new Error("Payload inválido: falta newAmountCents");

        await trx
          .update(recurringTransactions)
          .set({
            amountCents: BigInt(p.newAmountCents),
          })
          .where(
            and(
              eq(recurringTransactions.userId, session.id),
              eq(recurringTransactions.id, proposal.recurringId),
              notDeleted(recurringTransactions.deletedAt),
            ),
          );
      } else if (proposal.proposalType === "variable_flag") {
        await trx
          .update(recurringTransactions)
          .set({ amountType: "variable" })
          .where(
            and(
              eq(recurringTransactions.userId, session.id),
              eq(recurringTransactions.id, proposal.recurringId),
              notDeleted(recurringTransactions.deletedAt),
            ),
          );
      } else {
        throw new Error(`Tipo de propuesta desconocido: ${proposal.proposalType}`);
      }

      // 3. Mark the proposal as accepted.
      await trx
        .update(recurringProposals)
        .set({ status: "accepted", decidedAt: new Date() })
        .where(
          and(eq(recurringProposals.userId, session.id), eq(recurringProposals.id, proposalId)),
        );

      // 4. Mark related unapplied manual observations as applied=true.
      await trx
        .update(recurringLinkObservations)
        .set({ applied: true })
        .where(
          and(
            eq(recurringLinkObservations.userId, session.id),
            eq(recurringLinkObservations.recurringId, proposal.recurringId),
            eq(recurringLinkObservations.manual, true),
            eq(recurringLinkObservations.applied, false),
          ),
        );
    });

    log.info(
      { event: "proposal_accepted", proposalId, userId: session.id },
      "recurring proposal accepted",
    );

    revalidatePath("/");
    revalidatePath("/settings/recurring/learning");

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error inesperado";
    log.error(
      { err, event: "proposal_accept_failed", proposalId, userId: session.id },
      "failed to accept recurring proposal",
    );
    return { ok: false, error: message };
  }
}

/**
 * Reject a proposal — marks it as 'rejected' without changing the recurring.
 * The observations remain unapplied so the cron can potentially re-trigger
 * if the pattern continues.
 */
export async function rejectProposal(input: ProposalActionInput): Promise<ProposalActionResult> {
  const session = await getSessionUser();
  const parsed = proposalIdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Input inválido" };
  }
  const { proposalId } = parsed.data;

  try {
    const [proposal] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(and(eq(recurringProposals.userId, session.id), eq(recurringProposals.id, proposalId)))
      .limit(1);

    if (!proposal) return { ok: false, error: "Propuesta no encontrada" };
    if (proposal.status !== "pending") {
      return { ok: false, error: `Propuesta ya ${proposal.status}` };
    }

    await db
      .update(recurringProposals)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(and(eq(recurringProposals.userId, session.id), eq(recurringProposals.id, proposalId)));

    log.info(
      { event: "proposal_rejected", proposalId, userId: session.id },
      "recurring proposal rejected",
    );

    revalidatePath("/");
    revalidatePath("/settings/recurring/learning");

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error inesperado";
    return { ok: false, error: message };
  }
}

/**
 * Expire a proposal — used by cron cleanup to prune stale pending proposals
 * that are older than N days and were never decided.
 * Can also be called manually from the UI (admin/debug).
 */
export async function expireProposal(input: ProposalActionInput): Promise<ProposalActionResult> {
  const session = await getSessionUser();
  const parsed = proposalIdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Input inválido" };
  }
  const { proposalId } = parsed.data;

  try {
    const [proposal] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(and(eq(recurringProposals.userId, session.id), eq(recurringProposals.id, proposalId)))
      .limit(1);

    if (!proposal) return { ok: false, error: "Propuesta no encontrada" };

    // Only pending proposals can be expired.
    if (proposal.status !== "pending") {
      return { ok: false, error: `Propuesta ya ${proposal.status}` };
    }

    await db
      .update(recurringProposals)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(recurringProposals.userId, session.id), eq(recurringProposals.id, proposalId)));

    log.info(
      { event: "proposal_expired", proposalId, userId: session.id },
      "recurring proposal expired",
    );

    revalidatePath("/");
    revalidatePath("/settings/recurring/learning");

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error inesperado";
    return { ok: false, error: message };
  }
}

/**
 * Count pending proposals for a given user — used by the dashboard banner.
 * Exported as a plain async function (not a server action) so it can be called
 * from RSC without the "use server" boundary.
 */
export async function countPendingProposals(userId: number): Promise<number> {
  const result = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(recurringProposals)
    .where(and(eq(recurringProposals.userId, userId), eq(recurringProposals.status, "pending")))
    .limit(1);

  return result[0]?.count ?? 0;
}
