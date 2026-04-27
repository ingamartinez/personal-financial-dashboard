"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/display/money";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Currency } from "@/lib/types";
import { reviewReconciliationDecision } from "./actions";

function absBig(n: bigint): bigint {
  return n < BigInt(0) ? -n : n;
}

export type FlaggedRow = {
  id: number;
  occurredAt: string;
  amountCents: string;
  currency: "COP" | "USD";
  descriptionRaw: string;
  merchant: string | null;
  // Populated by the page loader: the merge-candidate id (statement copy)
  // that has the same amount within ±3 days. When present, the flagged row
  // is a duplicate and the recommended action is Archive.
  suggestedSiblingId: number | null;
  // "archive" — a sibling statement copy exists, so the flagged row is a
  //   duplicate. Acting on the suggestion archives it.
  // "keep"    — the row falls outside every reconciled period for this
  //   account, so the statement simply doesn't cover it yet. Acting on the
  //   suggestion resets the row to unreconciled (real).
  // null       — ambiguous; user must decide manually.
  suggestedAction: "archive" | "keep" | null;
};

export type MergeCandidate = {
  id: number;
  occurredAt: string;
  amountCents: string;
  currency: "COP" | "USD";
  descriptionRaw: string;
};

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "2-digit",
});

export function FlaggedReview({
  rows,
  currency,
  mergeCandidates,
}: {
  rows: FlaggedRow[];
  currency: Currency;
  mergeCandidates: MergeCandidate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [mergePicker, setMergePicker] = useState<FlaggedRow | null>(null);

  // Order: rows with a clear suggestion (archive or keep) first, then the
  // ambiguous ones. Within each group keep recency so users see the latest
  // activity at the top.
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aHas = a.suggestedAction !== null;
      const bHas = b.suggestedAction !== null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
    });
  }, [rows]);

  const suggestionCount = sortedRows.filter((r) => r.suggestedAction !== null).length;

  function handle(rowId: number, action: "archived" | "kept") {
    setBusy(rowId);
    startTransition(async () => {
      try {
        await reviewReconciliationDecision({ txnId: rowId, action });
        toast.success(
          action === "archived"
            ? "Transacción archivada — ya no aparece en el gasto"
            : "Transacción mantenida como real",
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No se pudo aplicar la acción");
      } finally {
        setBusy(null);
      }
    });
  }

  function applySuggestions() {
    const withSuggestion = sortedRows.filter((r) => r.suggestedAction !== null);
    if (withSuggestion.length === 0) return;
    const archiveCount = withSuggestion.filter((r) => r.suggestedAction === "archive").length;
    const keepCount = withSuggestion.filter((r) => r.suggestedAction === "keep").length;
    setBulkBusy(true);
    startTransition(async () => {
      try {
        await Promise.all(
          withSuggestion.map((r) =>
            reviewReconciliationDecision({
              txnId: r.id,
              action: r.suggestedAction === "archive" ? "archived" : "kept",
            }),
          ),
        );
        const parts: string[] = [];
        if (archiveCount > 0) parts.push(`${archiveCount} archivada(s)`);
        if (keepCount > 0) parts.push(`${keepCount} mantenida(s) como reales`);
        toast.success(parts.join(" · "));
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Bulk apply failed");
      } finally {
        setBulkBusy(false);
      }
    });
  }

  function handleMerge(flaggedId: number, targetId: number) {
    setBusy(flaggedId);
    startTransition(async () => {
      try {
        await reviewReconciliationDecision({
          txnId: flaggedId,
          action: "merged_into",
          mergedIntoTxnId: targetId,
        });
        toast.success("Fusionada — la fila adopta el monto y fecha del extracto");
        setMergePicker(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No se pudo fusionar");
      } finally {
        setBusy(null);
      }
    });
  }

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Flagged · {rows.length}</CardTitle>
            <CardDescription>
              Estas transacciones existen en findash (capturadas por email/SMS) pero el extracto que
              subiste no las trae. Para cada una:
              <ul className="mt-2 ml-4 list-disc space-y-1">
                <li>
                  <strong>Archive</strong> — la tx no es real (cancelación, reversal o duplicado).
                  Se oculta del gasto.
                </li>
                <li>
                  <strong>Keep</strong> — la tx es real (quedó fuera del extracto). Sigue activa.
                </li>
                <li>
                  <strong>Merge into…</strong> — la tx tiene una versión en el extracto pero con
                  otra descripción. Se fusionan.
                </li>
              </ul>
            </CardDescription>
          </div>
          {suggestionCount > 0 ? (
            <Button
              size="sm"
              onClick={applySuggestions}
              disabled={pending || bulkBusy}
              title="Archiva las duplicadas y mantiene las reales que quedaron fuera del extracto"
            >
              Aplicar sugerencias ({suggestionCount})
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="p-2 text-left">Date</th>
                <th className="p-2 text-left">Description</th>
                <th className="p-2 text-right">Amount</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const cents = BigInt(r.amountCents);
                const isBusy = busy === r.id || bulkBusy;
                const suggestion = r.suggestedAction;
                return (
                  <tr
                    key={r.id}
                    className={cn(
                      "border-t",
                      suggestion === "archive" && "bg-amber-50/40 dark:bg-amber-950/20",
                      suggestion === "keep" && "bg-sky-50/40 dark:bg-sky-950/20",
                    )}
                  >
                    <td className="p-2 tabular-nums">{dateFmt.format(new Date(r.occurredAt))}</td>
                    <td className="max-w-[18rem] truncate p-2">
                      <div className="flex flex-col gap-1">
                        <div className="truncate">
                          {r.descriptionRaw}
                          {r.merchant ? (
                            <span className="text-muted-foreground text-xs"> · {r.merchant}</span>
                          ) : null}
                        </div>
                        {suggestion === "archive" ? (
                          <Badge
                            variant="outline"
                            className="w-fit border-amber-500 text-amber-700 dark:text-amber-400"
                          >
                            Doble conteo · Archive recomendado
                          </Badge>
                        ) : null}
                        {suggestion === "keep" ? (
                          <Badge
                            variant="outline"
                            className="w-fit border-sky-500 text-sky-700 dark:text-sky-400"
                          >
                            Fuera del periodo del extracto · Keep recomendado
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className={cn(
                        "p-2 text-right font-medium tabular-nums",
                        cents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                      )}
                    >
                      <Money cents={cents} currency={currency} />
                    </td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handle(r.id, "archived")}
                          disabled={pending || isBusy}
                        >
                          Archive
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handle(r.id, "kept")}
                          disabled={pending || isBusy}
                        >
                          Keep
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMergePicker(r)}
                          disabled={pending || isBusy || mergeCandidates.length === 0}
                          title={
                            mergeCandidates.length === 0
                              ? "No statement-imported rows available to merge with"
                              : "Merge into a statement-imported row"
                          }
                        >
                          Merge into…
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
      <MergePickerDialog
        open={mergePicker !== null}
        flagged={mergePicker}
        candidates={mergeCandidates}
        currency={currency}
        disabled={pending}
        onClose={() => setMergePicker(null)}
        onPick={handleMerge}
      />
    </Card>
  );
}

type RankedCandidate = MergeCandidate & {
  amountDiffPct: number;
  isProbableMatch: boolean;
  isNoise: boolean;
};

function MergePickerDialog({
  open,
  flagged,
  candidates,
  currency,
  disabled,
  onClose,
  onPick,
}: {
  open: boolean;
  flagged: FlaggedRow | null;
  candidates: MergeCandidate[];
  currency: Currency;
  disabled: boolean;
  onClose: () => void;
  onPick: (flaggedId: number, targetId: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const ranked = useMemo<RankedCandidate[]>(() => {
    if (!flagged) return [];
    const flaggedAbs = absBig(BigInt(flagged.amountCents));
    const flaggedMs = new Date(flagged.occurredAt).getTime();
    const withDiff = candidates.map((c) => {
      const candAbs = absBig(BigInt(c.amountCents));
      const diff = candAbs > flaggedAbs ? candAbs - flaggedAbs : flaggedAbs - candAbs;
      const pct = flaggedAbs === BigInt(0) ? 1 : Number(diff) / Number(flaggedAbs);
      return { c, candAbs, pct };
    });
    withDiff.sort((a, b) => {
      if (a.pct !== b.pct) return a.pct - b.pct;
      const da = Math.abs(new Date(a.c.occurredAt).getTime() - flaggedMs);
      const db = Math.abs(new Date(b.c.occurredAt).getTime() - flaggedMs);
      return da - db;
    });
    return withDiff.map(({ c, pct }, idx) => ({
      ...c,
      amountDiffPct: pct,
      isProbableMatch: idx === 0 && pct < 0.02,
      isNoise: pct > 0.5,
    }));
  }, [flagged, candidates]);

  const visible = showAll ? ranked : ranked.filter((r) => !r.isNoise);
  const hiddenCount = ranked.length - visible.length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Merge flagged into…</DialogTitle>
          <DialogDescription>
            {flagged
              ? `Pick the statement-imported row that corresponds to "${flagged.descriptionRaw}" (${formatMoney(BigInt(flagged.amountCents), currency)}, ${dateFmt.format(new Date(flagged.occurredAt))}). The flagged row keeps its category and adopts the statement's amount + date.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-36" />
              <col />
              <col className="w-32" />
              <col className="w-24" />
            </colgroup>
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="p-2 text-left">Date</th>
                <th className="p-2 text-left">Description</th>
                <th className="p-2 text-right">Amount</th>
                <th className="p-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const cents = BigInt(c.amountCents);
                return (
                  <tr
                    key={c.id}
                    className={cn(
                      "border-t",
                      c.isProbableMatch && "bg-emerald-50/60 dark:bg-emerald-950/20",
                    )}
                  >
                    <td className="p-2 whitespace-nowrap tabular-nums">
                      {dateFmt.format(new Date(c.occurredAt))}
                    </td>
                    <td className="min-w-0 truncate p-2">
                      {c.descriptionRaw}
                      {c.isProbableMatch ? (
                        <Badge
                          variant="outline"
                          className="ml-2 border-emerald-500 text-emerald-700 dark:text-emerald-400"
                        >
                          Match probable
                        </Badge>
                      ) : null}
                    </td>
                    <td
                      className={cn(
                        "p-2 text-right font-medium tabular-nums",
                        cents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                      )}
                    >
                      <Money cents={cents} currency={currency} />
                    </td>
                    <td className="p-2 text-right">
                      <Button
                        size="sm"
                        variant={c.isProbableMatch ? "default" : "outline"}
                        disabled={disabled}
                        onClick={() => flagged && onPick(flagged.id, c.id)}
                      >
                        Merge
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {hiddenCount > 0 ? (
          <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
            <span>{hiddenCount} candidatos ocultos por diferencia de monto &gt; 50%.</span>
            <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
              Ver todos ({ranked.length})
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
