"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleXIcon, LinkIcon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  dismissUpcoming,
  fetchLinkCandidates,
  promoteUpcoming,
} from "@/app/settings/recurring/actions";
import { RecurringGapLinkDialog } from "@/components/dashboard/recurring-gap-link-dialog";
import type { LinkCandidate } from "@/lib/recurring/gap-queries";

export type RecurringGapItem = {
  gapId: number;
  recurringId: number;
  yearMonth: string;
  label: string;
  accountName: string;
  amountCents: string;
  currency: "COP" | "USD";
  categoryName: string | null;
  dayOfMonth: number;
};

const monthFmt = new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric" });

function formatYearMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return monthFmt.format(new Date(Date.UTC(y, m - 1, 1)));
}

function expectedOccurredOn(ym: string, dayOfMonth: number): string {
  const [y, m] = ym.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(dayOfMonth, days);
  return `${ym}-${String(d).padStart(2, "0")}`;
}

export function RecurringInboxCard({ gaps }: { gaps: RecurringGapItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [linking, setLinking] = useState<RecurringGapItem | null>(null);
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [dates, setDates] = useState<Record<number, string>>({});

  function onAssociate(item: RecurringGapItem) {
    setLinking(item);
    setCandidates(null);
    setSelectedCandidateId(null);
    fetchLinkCandidates(item.gapId)
      .then((rows) => setCandidates(rows))
      .catch(() => setCandidates([]));
  }

  function closeLinking() {
    setLinking(null);
    setCandidates(null);
    setSelectedCandidateId(null);
  }

  if (gaps.length === 0) return null;

  function onRefresh() {
    router.refresh();
  }

  function onDismiss(item: RecurringGapItem) {
    startTransition(async () => {
      try {
        await dismissUpcoming({
          recurringId: item.recurringId,
          ym: item.yearMonth,
        });
        toast.success(`Marcado como no pagado: ${item.label}`);
        onRefresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  function onPaidSubmit(item: RecurringGapItem, e: React.FormEvent) {
    e.preventDefault();
    const raw = amounts[item.gapId] ?? "";
    const amtNum = Number(raw);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      toast.error("Monto debe ser > 0");
      return;
    }
    const occurredOn = dates[item.gapId] ?? expectedOccurredOn(item.yearMonth, item.dayOfMonth);
    const centsMagnitude = Math.round(amtNum * 100);

    startTransition(async () => {
      try {
        await promoteUpcoming({
          recurringId: item.recurringId,
          yearMonth: item.yearMonth,
          occurredOn,
          amountCents: String(centsMagnitude),
        });
        toast.success(`Registrado ${item.label}`);
        setExpanded(null);
        onRefresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  return (
    <>
      <Card className="border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20">
        <CardHeader>
          <CardDescription>Pendientes de resolver</CardDescription>
          <CardTitle className="text-lg">Recurrentes sin tx asociada ({gaps.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {gaps.map((item) => {
              const cents = BigInt(item.amountCents);
              const expectedAbs = cents < BigInt(0) ? -cents : cents;
              const isOpen = expanded === item.gapId;
              const amountValue = amounts[item.gapId] ?? (Number(expectedAbs) / 100).toString();
              const dateValue =
                dates[item.gapId] ?? expectedOccurredOn(item.yearMonth, item.dayOfMonth);
              return (
                <li key={item.gapId} className="flex flex-col gap-2 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{item.label}</span>
                        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] tracking-wide uppercase dark:bg-amber-900/60">
                          {formatYearMonth(item.yearMonth)}
                        </span>
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {item.accountName}
                        {item.categoryName ? ` · ${item.categoryName}` : ""} · día {item.dayOfMonth}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "w-28 text-right font-medium tabular-nums",
                        cents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                      )}
                    >
                      {formatMoney(cents, item.currency)}
                    </div>
                  </div>
                  {isOpen ? (
                    <form
                      onSubmit={(e) => onPaidSubmit(item, e)}
                      className="bg-background flex flex-wrap items-end gap-2 rounded border p-3"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <Label htmlFor={`amt-${item.gapId}`} className="text-xs">
                          Monto pagado ({item.currency})
                        </Label>
                        <Input
                          id={`amt-${item.gapId}`}
                          type="number"
                          inputMode="decimal"
                          step={item.currency === "USD" ? "0.01" : "1"}
                          min="0"
                          value={amountValue}
                          onChange={(e) =>
                            setAmounts((m) => ({ ...m, [item.gapId]: e.target.value }))
                          }
                          required
                          autoFocus
                          className="tabular-nums"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`date-${item.gapId}`} className="text-xs">
                          Fecha
                        </Label>
                        <Input
                          id={`date-${item.gapId}`}
                          type="date"
                          value={dateValue}
                          onChange={(e) =>
                            setDates((m) => ({ ...m, [item.gapId]: e.target.value }))
                          }
                          required
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setExpanded(null)}
                          disabled={pending}
                        >
                          Cancelar
                        </Button>
                        <Button type="submit" size="sm" disabled={pending}>
                          {pending ? "Guardando…" : "Confirmar"}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => onAssociate(item)}
                      >
                        <LinkIcon className="size-3.5" />
                        Asociar tx
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => setExpanded(item.gapId)}
                      >
                        <WalletIcon className="size-3.5" />
                        Pagué…
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => onDismiss(item)}
                      >
                        <CircleXIcon className="size-3.5" />
                        No pagué
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
      {linking ? (
        <RecurringGapLinkDialog
          open={linking !== null}
          onOpenChange={(o) => {
            if (!o) closeLinking();
          }}
          recurringId={linking.recurringId}
          yearMonth={linking.yearMonth}
          label={linking.label}
          expectedAmountCents={BigInt(linking.amountCents)}
          currency={linking.currency}
          candidates={candidates}
          selectedTxId={selectedCandidateId}
          onSelect={setSelectedCandidateId}
          onLinked={() => {
            closeLinking();
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
