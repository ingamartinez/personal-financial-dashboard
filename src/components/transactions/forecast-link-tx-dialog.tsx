"use client";

// #632: Redesigned picker dialog for "Asociar tx existente".
// Changes from #622 original:
//   - Default scope: ALL accounts (no account filter). Window-based always.
//   - showAll toggle: expands window to [expectedDate-30d, expectedDate+10d],
//     NEVER falls back to month-calendar.
//   - Two sections: "Sugeridas" (same currency, ±20% amount) + "Todas" (rest).
//   - Client-side search bar filtering both sections by description/merchant.
//   - formatAccountLabel for multi-currency card disambiguation.

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/display/money";
import { cn } from "@/lib/utils";
import { getLinkCandidatesForForecast } from "@/app/(app)/transactions/forecast-actions";
import { linkTxToRecurring } from "@/app/(app)/transactions/actions";
import type {
  ForecastLinkCandidate,
  ForecastLinkCandidatesResult,
} from "@/app/(app)/transactions/forecast-actions";
import type { Currency } from "@/lib/types";

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

function CandidateRow({
  c,
  selected,
  onClick,
}: {
  c: ForecastLinkCandidate;
  selected: boolean;
  onClick: () => void;
}) {
  const isExpense = c.amountCents < BigInt(0);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "hover:bg-accent flex items-center gap-3 rounded border px-3 py-2 text-left text-sm transition",
        selected && "border-primary bg-primary/5",
      )}
    >
      <div className="text-muted-foreground w-14 shrink-0 text-xs">
        {dateFmt.format(c.occurredAt)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{c.merchant ?? c.descriptionRaw}</div>
        {c.merchant ? (
          <div className="text-muted-foreground truncate text-xs">{c.descriptionRaw}</div>
        ) : null}
        <div className="text-muted-foreground truncate text-xs">{c.accountName}</div>
      </div>
      <div
        className={cn("shrink-0 tabular-nums", isExpense ? "text-rose-600" : "text-emerald-600")}
      >
        <Money cents={c.amountCents} currency={c.currency as Currency} />
      </div>
    </button>
  );
}

export function ForecastLinkTxDialog({
  open,
  onOpenChange,
  recurringId,
  yearMonth,
  label,
  expectedAmountCents,
  currency,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recurringId: number;
  yearMonth: string;
  label: string;
  expectedAmountCents: bigint;
  currency: Currency;
  onLinked: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [showAll, setShowAll] = useState(false);
  const [result, setResult] = useState<ForecastLinkCandidatesResult | null>(null);
  const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const loadCandidates = useCallback(
    (all: boolean) => {
      getLinkCandidatesForForecast({ recurringId, yearMonth, showAll: all })
        .then((res) => {
          setResult(res);
          setLoadError(null);
        })
        .catch((err) => {
          setLoadError(err instanceof Error ? err.message : "Error cargando candidatos");
          setResult({
            sugeridas: [],
            todas: [],
            recurringAmountCents: expectedAmountCents,
            recurringCurrency: currency,
          });
        });
    },
    [recurringId, yearMonth, expectedAmountCents, currency],
  );

  function triggerLoad(all: boolean) {
    setResult(null);
    setLoadError(null);
    loadCandidates(all);
  }

  useEffect(() => {
    if (open) {
      loadCandidates(false);
    }
  }, [open, recurringId, yearMonth, loadCandidates]);

  function onClose(next: boolean) {
    if (!pending) {
      if (!next) {
        setShowAll(false);
        setSelectedTxId(null);
        setResult(null);
        setLoadError(null);
        setSearch("");
      }
      onOpenChange(next);
    }
  }

  function onLink() {
    if (selectedTxId === null) return;
    startTransition(async () => {
      const res = await linkTxToRecurring({ txId: selectedTxId, recurringId, yearMonth });
      if (res.ok) {
        toast.success(`Asociado a ${label}`, { description: `Mes ${yearMonth}` });
        setSelectedTxId(null);
        onLinked();
        onOpenChange(false);
      } else {
        toast.error("No se pudo asociar", { description: res.error });
      }
    });
  }

  // Client-side search filter — no server roundtrip per keystroke.
  const query = search.trim().toLowerCase();
  const filteredSugeridas = useMemo(
    () =>
      query
        ? (result?.sugeridas ?? []).filter(
            (c) =>
              c.descriptionRaw.toLowerCase().includes(query) ||
              (c.merchant ?? "").toLowerCase().includes(query) ||
              c.accountName.toLowerCase().includes(query),
          )
        : (result?.sugeridas ?? []),
    [result, query],
  );
  const filteredTodas = useMemo(
    () =>
      query
        ? (result?.todas ?? []).filter(
            (c) =>
              c.descriptionRaw.toLowerCase().includes(query) ||
              (c.merchant ?? "").toLowerCase().includes(query) ||
              c.accountName.toLowerCase().includes(query),
          )
        : (result?.todas ?? []),
    [result, query],
  );

  const totalFiltered = filteredSugeridas.length + filteredTodas.length;
  const hasSugeridas = filteredSugeridas.length > 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Asociar tx existente — {label}</DialogTitle>
          <DialogDescription>
            Mes {yearMonth} · esperado <Money cents={expectedAmountCents} currency={currency} />
          </DialogDescription>
        </DialogHeader>

        {/* Search bar */}
        <div className="relative">
          <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            placeholder="Buscar por descripción…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            disabled={pending}
          />
        </div>

        {/* showAll toggle — expands window, never month-calendar */}
        <div className="bg-muted/30 flex items-center gap-3 rounded-md border px-3 py-2">
          <Checkbox
            id="show-all"
            checked={showAll}
            onCheckedChange={(checked) => {
              const next = checked === true;
              setShowAll(next);
              setSelectedTxId(null);
              setSearch("");
              triggerLoad(next);
            }}
            disabled={pending}
          />
          <Label htmlFor="show-all" className="cursor-pointer text-sm font-normal">
            Ampliar ventana (±30d/+10d)
          </Label>
        </div>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {result === null ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : loadError ? (
            <p className="text-destructive py-6 text-center text-sm">{loadError}</p>
          ) : totalFiltered > 0 ? (
            <>
              {/* Sugeridas section */}
              {hasSugeridas ? (
                <div className="flex flex-col gap-1">
                  <p className="text-muted-foreground px-1 pt-1 text-xs font-medium tracking-wide uppercase">
                    Sugeridas
                  </p>
                  {filteredSugeridas.map((c) => (
                    <CandidateRow
                      key={c.txId}
                      c={c}
                      selected={selectedTxId === c.txId}
                      onClick={() => setSelectedTxId(c.txId)}
                    />
                  ))}
                </div>
              ) : null}

              {/* Todas section */}
              {filteredTodas.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {hasSugeridas ? (
                    <p className="text-muted-foreground px-1 pt-2 text-xs font-medium tracking-wide uppercase">
                      Todas
                    </p>
                  ) : null}
                  {filteredTodas.map((c) => (
                    <CandidateRow
                      key={c.txId}
                      c={c}
                      selected={selectedTxId === c.txId}
                      onClick={() => setSelectedTxId(c.txId)}
                    />
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {query
                ? "Sin resultados para esa búsqueda."
                : showAll
                  ? "No hay transacciones sin asociar en la ventana ampliada."
                  : "No hay candidatas en la ventana ±10d/+5d. Activá «Ampliar ventana» para ampliar."}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={onLink} disabled={selectedTxId === null || pending}>
            {pending ? "Asociando…" : "Asociar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
