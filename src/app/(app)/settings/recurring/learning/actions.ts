"use server";

// #633: Server actions for learning proposal lifecycle.
// Tenant-safe: userId ALWAYS from getSessionUser(), never from caller input.

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  recurringProposals,
  recurringTransactions,
  recurringLinkObservations,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { medianOfLast3SameCurrency } from "@/lib/insights/cash-flow";
import { createLogger } from "@/lib/logger";
import type { ProposalActionResult, ProposalActionInput } from "./learning-types";
import { proposalIdSchema } from "./learning-types";

const log = createLogger({ module: "settings/recurring/learning/actions" });

/**
 * Accept a proposal:
 *   - amount_update: updates recurring.amount_cents to the proposed value.
 *   - variable_flag: sets recurring.amount_type = 'variable'.
 *   - amount_outlier: "new_normal" keeps the observation in the band;
 *     "one_off" sets excluded_at. Both recompute amount_cents from the median.
 * amount_update and variable_flag also mark linked observations as applied=true.
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
        const p = proposal.payload as { newAmountCents: string; currency?: string };
        if (!p.newAmountCents) throw new Error("Payload inválido: falta newAmountCents");

        // #870: fetch the recurring's CURRENT currency + amount — both may
        // have drifted since the worker computed this proposal (the
        // recurring can be re-pointed to a different-currency account, or a
        // prior accept/edit may have already landed the same value).
        const [recurring] = await trx
          .select({
            currency: recurringTransactions.currency,
            amountCents: recurringTransactions.amountCents,
          })
          .from(recurringTransactions)
          .where(
            and(
              eq(recurringTransactions.userId, session.id),
              eq(recurringTransactions.id, proposal.recurringId),
              notDeleted(recurringTransactions.deletedAt),
            ),
          )
          .limit(1);

        if (!recurring) throw new Error("Recurrente no encontrado");

        // Cross-currency guard: never write an amount computed in one
        // currency onto a recurring that now lives in another. The
        // proposal is stale — the worker's next run will expire it.
        if (p.currency && p.currency !== recurring.currency) {
          throw new Error(
            `Propuesta en ${p.currency} pero el recurrente ahora está en ${recurring.currency} — descartala`,
          );
        }

        const newAmountCents = BigInt(p.newAmountCents);

        // No-op guard: the recurring's estimate already matches the
        // proposed value (e.g. a prior accept already applied it, or the
        // currency migration coincidentally left the same figure). Treat
        // as decided without rewriting anything.
        if (newAmountCents !== recurring.amountCents) {
          await trx
            .update(recurringTransactions)
            .set({
              amountCents: newAmountCents,
            })
            .where(
              and(
                eq(recurringTransactions.userId, session.id),
                eq(recurringTransactions.id, proposal.recurringId),
                notDeleted(recurringTransactions.deletedAt),
              ),
            );
        }
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
      } else if (proposal.proposalType === "amount_outlier") {
        const decision = parsed.data.outlierDecision;
        if (decision !== "new_normal" && decision !== "one_off") {
          throw new Error("Esta propuesta necesita una decisión: nuevo normal o puntual");
        }
        const p = proposal.payload as { observationId?: unknown };
        if (typeof p.observationId !== "number") {
          throw new Error("Payload inválido: falta observationId");
        }

        const [recurring] = await trx
          .select({
            amountCents: recurringTransactions.amountCents,
            currency: recurringTransactions.currency,
          })
          .from(recurringTransactions)
          .where(
            and(
              eq(recurringTransactions.userId, session.id),
              eq(recurringTransactions.id, proposal.recurringId),
              notDeleted(recurringTransactions.deletedAt),
            ),
          )
          .limit(1);
        if (!recurring) throw new Error("Recurrente no encontrado");

        if (decision === "one_off") {
          const excluded = await trx
            .update(recurringLinkObservations)
            .set({ excludedAt: new Date() })
            .where(
              and(
                eq(recurringLinkObservations.userId, session.id),
                eq(recurringLinkObservations.recurringId, proposal.recurringId),
                eq(recurringLinkObservations.id, p.observationId),
              ),
            )
            .returning({ id: recurringLinkObservations.id });
          if (excluded.length === 0) throw new Error("Observación no encontrada");
        }

        const remaining = await trx
          .select({
            realAmountCents: recurringLinkObservations.realAmountCents,
            realCurrency: recurringLinkObservations.realCurrency,
            observedAt: recurringLinkObservations.observedAt,
            excludedAt: recurringLinkObservations.excludedAt,
          })
          .from(recurringLinkObservations)
          .where(
            and(
              eq(recurringLinkObservations.userId, session.id),
              eq(recurringLinkObservations.recurringId, proposal.recurringId),
              isNull(recurringLinkObservations.excludedAt),
            ),
          );
        const median = medianOfLast3SameCurrency(remaining, recurring.currency);
        if (median !== null && median !== recurring.amountCents) {
          await trx
            .update(recurringTransactions)
            .set({ amountCents: median })
            .where(
              and(
                eq(recurringTransactions.userId, session.id),
                eq(recurringTransactions.id, proposal.recurringId),
                notDeleted(recurringTransactions.deletedAt),
              ),
            );
        }
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
      // amount_outlier does not consume the observation set — "nuevo normal"
      // keeps the spike in the band, "fue puntual" sets excluded_at on one row.
      if (proposal.proposalType !== "amount_outlier") {
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
      }
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
 * Count pending proposals for the current session user — used by the dashboard banner.
 * Derives userId from getSessionUser() internally. Never accepts userId as a parameter
 * because this file is "use server" and every async export is an invocable server action.
 */
export async function countPendingProposals(): Promise<number> {
  const session = await getSessionUser();

  const result = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(recurringProposals)
    .where(and(eq(recurringProposals.userId, session.id), eq(recurringProposals.status, "pending")))
    .limit(1);

  return result[0]?.count ?? 0;
}
