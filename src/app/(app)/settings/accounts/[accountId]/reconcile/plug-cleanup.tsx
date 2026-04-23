"use client";

// #434 — UI for reviewing + batch-archiving balance_adjustment plugs on a
// single account. Pairs with the #433 saldo-real flow: consolidating with
// a "saldo real" input leaves a plug tx behind; after several months of real
// imports, older plugs become obsolete. This surface lets the user clear
// them in batch with a projected-balance preview.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import {
  archiveBalanceAdjustmentsAction,
  restoreBalanceAdjustmentAction,
} from "./plug-cleanup-actions";

export type Plug = {
  id: number;
  occurredAtISO: string;
  amountCentsStr: string; // ledger-signed
  description: string;
  statementImportId: number | null;
  deleted: boolean; // true when soft-deleted (deletedAt IS NOT NULL)
};

type Props = {
  accountId: number;
  currentBalanceCentsStr: string;
  plugs: Plug[];
  // Cut-off used for the "probablemente obsoleto" heuristic: plugs dated ≤
  // max(statement_imports.periodEnd) for this account are candidates (we've
  // likely imported the real data they were compensating for).
  lastStatementPeriodEndISO: string | null;
};

function formatSignedCents(str: string): string {
  if (!str) return "—";
  const big = BigInt(str);
  const negative = big < BigInt(0);
  const abs = negative ? -big : big;
  const units = abs / BigInt(100);
  const frac = (abs % BigInt(100)).toString().padStart(2, "0");
  const unitsStr = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sign = negative ? "-" : big > BigInt(0) ? "+" : "";
  return `${sign}$${unitsStr},${frac}`;
}

function formatBogotaDate(iso: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(new Date(iso));
}

export function PlugCleanupSection({
  accountId,
  currentBalanceCentsStr,
  plugs,
  lastStatementPeriodEndISO,
}: Props) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showDeleted, setShowDeleted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archiving, startArchiving] = useTransition();
  const [restoringId, setRestoringId] = useState<number | null>(null);

  const visiblePlugs = useMemo(
    () => (showDeleted ? plugs : plugs.filter((p) => !p.deleted)),
    [plugs, showDeleted],
  );

  const obsoleteCutoff = lastStatementPeriodEndISO
    ? new Date(lastStatementPeriodEndISO).getTime()
    : null;

  function isProbablyObsolete(p: Plug): boolean {
    if (obsoleteCutoff === null || p.deleted) return false;
    return new Date(p.occurredAtISO).getTime() <= obsoleteCutoff;
  }

  const selectedPlugs = useMemo(
    () => visiblePlugs.filter((p) => selectedIds.has(p.id) && !p.deleted),
    [visiblePlugs, selectedIds],
  );
  const selectedSumCents = useMemo(
    () => selectedPlugs.reduce((acc, p) => acc + BigInt(p.amountCentsStr), BigInt(0)),
    [selectedPlugs],
  );

  const currentBalance = BigInt(currentBalanceCentsStr);
  // Archiving a plug removes its contribution from the derived balance, i.e.
  // subtracts its amount. Projected = current - sum(selected).
  const projectedBalance = currentBalance - selectedSumCents;

  function toggleId(id: number, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllLive(checked: boolean) {
    setSelectedIds(() => {
      if (!checked) return new Set();
      const next = new Set<number>();
      for (const p of visiblePlugs) if (!p.deleted) next.add(p.id);
      return next;
    });
  }

  function onConfirmArchive() {
    if (selectedPlugs.length === 0) return;
    const fd = new FormData();
    fd.set("accountId", String(accountId));
    fd.set("txIds", JSON.stringify(selectedPlugs.map((p) => p.id)));
    startArchiving(async () => {
      try {
        const result = await archiveBalanceAdjustmentsAction(fd);
        toast.success(
          `${result.archivedCount} ajuste${result.archivedCount === 1 ? "" : "s"} archivado${
            result.archivedCount === 1 ? "" : "s"
          }.`,
        );
        setSelectedIds(new Set());
        setConfirmOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No pude archivar los ajustes.");
      }
    });
  }

  function onRestore(txId: number) {
    setRestoringId(txId);
    const fd = new FormData();
    fd.set("accountId", String(accountId));
    fd.set("txId", String(txId));
    startArchiving(async () => {
      try {
        await restoreBalanceAdjustmentAction(fd);
        toast.success("Ajuste restaurado.");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No pude restaurar.");
      } finally {
        setRestoringId(null);
      }
    });
  }

  const anyLive = visiblePlugs.some((p) => !p.deleted);
  const allLiveSelected =
    anyLive && visiblePlugs.filter((p) => !p.deleted).every((p) => selectedIds.has(p.id));

  return (
    <Card data-testid="plug-cleanup-section">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Ajustes de saldo</CardTitle>
          <CardDescription>
            Los <code>balance_adjustment</code> plugs de esta cuenta. Borralos cuando ya no aplican
            (importaste los movimientos que estaban tapando, o cuadraste por otro lado). Soft-delete
            — podés deshacer desde acá.
          </CardDescription>
        </div>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            className="size-4"
          />
          Mostrar borrados
        </label>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {visiblePlugs.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {showDeleted
              ? "No hay ajustes en esta cuenta."
              : "No hay ajustes activos. Activá 'Mostrar borrados' para ver el historial."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="w-8 py-2">
                      <input
                        type="checkbox"
                        checked={allLiveSelected}
                        disabled={!anyLive}
                        aria-label="Seleccionar todos"
                        onChange={(e) => toggleAllLive(e.target.checked)}
                        className="size-4"
                      />
                    </th>
                    <th className="py-2 pr-3">Fecha</th>
                    <th className="py-2 pr-3 text-right">Monto</th>
                    <th className="py-2 pr-3">Descripción</th>
                    <th className="py-2 pr-3">Origen</th>
                    <th className="py-2 pr-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePlugs.map((p) => {
                    const isPostConsolidation = p.statementImportId !== null;
                    const obsolete = isProbablyObsolete(p);
                    return (
                      <tr
                        key={p.id}
                        data-testid={`plug-row-${p.id}`}
                        className={cn("border-t", p.deleted && "text-muted-foreground opacity-60")}
                      >
                        <td className="py-2">
                          {!p.deleted ? (
                            <input
                              type="checkbox"
                              checked={selectedIds.has(p.id)}
                              onChange={(e) => toggleId(p.id, e.target.checked)}
                              className="size-4"
                              data-testid={`plug-row-checkbox-${p.id}`}
                              aria-label={`Seleccionar ajuste #${p.id}`}
                            />
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatBogotaDate(p.occurredAtISO)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {formatSignedCents(p.amountCentsStr)}
                        </td>
                        <td className="truncate py-2 pr-3">{p.description}</td>
                        <td className="flex flex-wrap gap-1 py-2 pr-3">
                          {isPostConsolidation ? (
                            <Badge variant="secondary" className="text-[10px]">
                              post-consolidación
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">
                              manual
                            </Badge>
                          )}
                          {obsolete ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/50 bg-amber-50 text-[10px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                              title="Fue creado antes del último ciclo consolidado — probablemente compensaba movimientos que ya tenés importados."
                            >
                              probablemente obsoleto
                            </Badge>
                          ) : null}
                          {p.deleted ? (
                            <Badge variant="outline" className="text-[10px]">
                              borrado
                            </Badge>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {p.deleted ? (
                            <button
                              type="button"
                              onClick={() => onRestore(p.id)}
                              disabled={restoringId === p.id || archiving}
                              className="text-primary text-xs underline"
                              data-testid={`plug-restore-${p.id}`}
                            >
                              {restoringId === p.id ? "Restaurando…" : "Restaurar"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-2 border-t pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="text-muted-foreground">
                {selectedPlugs.length > 0 ? (
                  <span data-testid="plug-cleanup-selection-summary">
                    {selectedPlugs.length} seleccionado{selectedPlugs.length === 1 ? "" : "s"} ·
                    suma{" "}
                    <span className="text-foreground tabular-nums">
                      {formatSignedCents(selectedSumCents.toString())}
                    </span>
                  </span>
                ) : (
                  <span className="text-xs">Seleccioná al menos uno para borrar.</span>
                )}
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={selectedPlugs.length === 0 || archiving}
                onClick={() => setConfirmOpen(true)}
                data-testid="plug-cleanup-archive-button"
              >
                Borrar seleccionados
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Borrar {selectedPlugs.length} ajuste{selectedPlugs.length === 1 ? "" : "s"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                <span>
                  Vas a archivar {selectedPlugs.length} ajuste
                  {selectedPlugs.length === 1 ? "" : "s"} por un total de{" "}
                  <span className="font-semibold tabular-nums">
                    {formatSignedCents(selectedSumCents.toString())}
                  </span>
                  .
                </span>
                <span>
                  Tu saldo disponible cambiará de{" "}
                  <span className="font-medium tabular-nums">
                    {formatSignedCents(currentBalance.toString())}
                  </span>{" "}
                  a{" "}
                  <span className="font-medium tabular-nums">
                    {formatSignedCents(projectedBalance.toString())}
                  </span>
                  .
                </span>
                <span className="text-muted-foreground text-xs">
                  Soft-delete: podés deshacerlo después activando &quot;Mostrar borrados&quot;.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiving}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={archiving}
              onClick={(e) => {
                e.preventDefault();
                onConfirmArchive();
              }}
              data-testid="plug-cleanup-archive-confirm"
            >
              {archiving ? "Archivando…" : "Borrar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
