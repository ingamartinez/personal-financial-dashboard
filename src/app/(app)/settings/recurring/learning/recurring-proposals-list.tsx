"use client";

// #633: Client component — renders the list of pending learning proposals
// with accept/reject buttons.

import { useState, useTransition } from "react";
import { CheckIcon, XIcon, TrendingUpIcon, ActivityIcon, AlertTriangleIcon } from "lucide-react";
import { formatMoney } from "@/lib/money";
import type { Currency } from "@/lib/types";
import { acceptProposal, rejectProposal } from "./actions";

type Proposal = {
  id: number;
  recurringId: number;
  label: string;
  accountLabel: string;
  proposalType: "amount_update" | "variable_flag" | "amount_outlier";
  payload: Record<string, unknown>;
  createdAt: string;
};

type ProposalCardProps = {
  proposal: Proposal;
  onDecided: (id: number) => void;
};

// #870: currency MUST come from the proposal payload, not a hardcoded COP —
// a proposal generated while a recurring lived in USD (later migrated to
// COP) still carries its original currency in payload.currency.
function absCents(cents: bigint): bigint {
  return cents < BigInt(0) ? -cents : cents;
}

// Magnitudes only. Payloads stay signed (the money convention); this card's
// copy is "pagaste X", so a leading minus is noise. Restores the pre-#870
// abs that formatMoney does not do.
function formatCents(cents: string | undefined, currency: Currency): string {
  if (!cents) return "—";
  return formatMoney(absCents(BigInt(cents)), currency);
}

function formatBandRange(
  loAbs: string | undefined,
  hiAbs: string | undefined,
  currency: Currency,
): string {
  const a = loAbs ? absCents(BigInt(loAbs)) : BigInt(0);
  const b = hiAbs ? absCents(BigInt(hiAbs)) : BigInt(0);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `${formatMoney(lo, currency)} – ${formatMoney(hi, currency)}`;
}

function ProposalCard({ proposal, onDecided }: ProposalCardProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleAccept(outlierDecision?: "new_normal" | "one_off") {
    setError(null);
    startTransition(async () => {
      const result = await acceptProposal(
        outlierDecision
          ? { proposalId: proposal.id, outlierDecision }
          : { proposalId: proposal.id },
      );
      if (result.ok) {
        onDecided(proposal.id);
      } else {
        setError(result.error);
      }
    });
  }

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectProposal({ proposalId: proposal.id });
      if (result.ok) {
        onDecided(proposal.id);
      } else {
        setError(result.error);
      }
    });
  }

  const isAmountUpdate = proposal.proposalType === "amount_update";
  const isOutlier = proposal.proposalType === "amount_outlier";
  const p = proposal.payload;
  // #870: proposal currency is authoritative for the amounts on this card —
  // it may disagree with the account's own currency (a COP recurring can
  // sit on a USD account), so it's surfaced explicitly rather than assumed.
  // Real runtime narrowing, NOT a blind `as Currency` cast: `p` is
  // `Record<string, unknown>` (raw jsonb), so any unexpected value here
  // (hand-edited row, a future payload shape) must degrade to a rendered
  // amount rather than reach `formatMoney`'s `Intl.NumberFormat`, which
  // throws a synchronous RangeError on an invalid ISO code — taking down
  // the whole proposals page, not just this card.
  const proposalCurrency: Currency = p.currency === "USD" ? "USD" : "COP";

  return (
    <article
      className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-700 dark:bg-neutral-800"
      data-testid="proposal-card"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-md bg-blue-50 p-1.5 dark:bg-blue-900/30">
          {isOutlier ? (
            <AlertTriangleIcon className="size-4 text-amber-600 dark:text-amber-400" />
          ) : isAmountUpdate ? (
            <TrendingUpIcon className="size-4 text-blue-600 dark:text-blue-400" />
          ) : (
            <ActivityIcon className="size-4 text-purple-600 dark:text-purple-400" />
          )}
        </span>

        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="font-medium">{proposal.label}</strong>
            <span className="text-ink-muted text-xs">{proposal.accountLabel}</span>
            <span
              className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300"
              data-testid="proposal-currency"
            >
              {proposalCurrency}
            </span>
          </div>

          {isAmountUpdate ? (
            <p className="text-sm">
              Detectamos que pagaste{" "}
              <strong>{formatCents(p.newAmountCents as string, proposalCurrency)}</strong> los
              últimos {p.observationCount as number} meses (estimado:{" "}
              {formatCents(p.oldAmountCents as string, proposalCurrency)}).{" "}
              <span className="text-ink-muted">¿Actualizar el estimado?</span>
            </p>
          ) : isOutlier ? (
            <p className="text-sm">
              El último pago ({formatCents(p.outlierAmountCents as string, proposalCurrency)}) está
              fuera de la banda histórica (
              <span data-testid="outlier-band">
                {formatBandRange(
                  p.bandLoAbsCents as string,
                  p.bandHiAbsCents as string,
                  proposalCurrency,
                )}
              </span>
              ). <span className="text-ink-muted">¿Es el nuevo normal o fue puntual?</span>
            </p>
          ) : (
            <p className="text-sm">
              Pagaste montos distintos en los últimos {p.observationCount as number} meses (
              {(p.detectedAmounts as string[])
                .map((c) => formatCents(c, proposalCurrency))
                .join(", ")}
              ). <span className="text-ink-muted">¿Marcar como monto variable?</span>
            </p>
          )}

          {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        {isOutlier ? (
          <>
            <button
              type="button"
              onClick={() => handleAccept("new_normal")}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="proposal-outlier-new-normal"
            >
              <CheckIcon className="size-3.5" />
              Es el nuevo normal
            </button>
            <button
              type="button"
              onClick={() => handleAccept("one_off")}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
              data-testid="proposal-outlier-one-off"
            >
              <XIcon className="size-3.5" />
              Fue puntual
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => handleAccept()}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="proposal-accept"
            >
              <CheckIcon className="size-3.5" />
              Actualizar
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
              data-testid="proposal-reject"
            >
              <XIcon className="size-3.5" />
              Descartar
            </button>
          </>
        )}
      </div>
    </article>
  );
}

type Props = {
  proposals: Proposal[];
};

export function RecurringProposalsList({ proposals: initialProposals }: Props) {
  const [proposals, setProposals] = useState(initialProposals);

  function handleDecided(id: number) {
    setProposals((prev) => prev.filter((p) => p.id !== id));
  }

  if (proposals.length === 0) {
    return (
      <div
        className="text-ink-muted rounded-lg border border-dashed border-neutral-300 py-12 text-center text-sm dark:border-neutral-700"
        data-testid="proposals-empty"
      >
        Sin sugerencias pendientes — Findash está al día.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="proposals-list">
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} onDecided={handleDecided} />
      ))}
    </div>
  );
}
