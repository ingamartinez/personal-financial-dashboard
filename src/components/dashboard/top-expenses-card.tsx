"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useNewIds } from "@/lib/hooks/use-new-ids";
import { Money } from "@/components/display/money";
import { hasSecondaryDescription, primaryDescription } from "@/lib/transactions/description";
import type { TopExpense } from "@/lib/dashboard/queries";

const dateFmt = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short" });

function offsetUtcDate(d: Date, days: number): string {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

function buildDeepLink(tx: TopExpense): string {
  const params = new URLSearchParams({
    from: offsetUtcDate(tx.occurredAt, -1),
    to: offsetUtcDate(tx.occurredAt, 1),
    highlight: String(tx.id),
  });
  return `/transactions?${params.toString()}`;
}

export function TopExpensesCard({
  rows,
  monthLabel,
  ym,
  isFuture = false,
}: {
  rows: TopExpense[];
  monthLabel: string;
  ym: string;
  isFuture?: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const newIds = useNewIds(rowIds, { resetKey: ym });
  const enterInitial = shouldReduceMotion ? false : { opacity: 0, y: -8 };
  const enterAnimate = { opacity: 1, y: 0 };
  const enterTransition = { duration: 0.25, ease: "easeOut" as const };

  return (
    <Card>
      <CardHeader>
        <CardDescription>Top expenses · {monthLabel}</CardDescription>
        <CardTitle className="text-base">{rows.length} of top 5</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-muted-foreground text-sm">
            {isFuture ? "Sin datos todavía — este mes aún no ocurrió" : "No expenses this month"}
          </div>
        ) : (
          <ul className="flex flex-col divide-y">
            <AnimatePresence initial={false}>
              {rows.map((r) => {
                const isNew = newIds.has(r.id);
                const showSecondary = hasSecondaryDescription(r);
                return (
                  <motion.li
                    key={r.id}
                    className={cn(isNew && "tx-row-new")}
                    initial={enterInitial}
                    animate={enterAnimate}
                    transition={enterTransition}
                  >
                    <Link
                      href={buildDeepLink(r)}
                      className="hover:bg-muted/50 flex items-start justify-between gap-3 rounded-sm px-2 py-2 text-sm transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{primaryDescription(r)}</div>
                        {showSecondary ? (
                          <div className="text-muted-foreground line-clamp-1 text-xs">
                            {r.descriptionRaw}
                          </div>
                        ) : null}
                        <div className="text-muted-foreground text-xs">
                          {dateFmt.format(r.occurredAt)} · {r.accountName}
                          {r.categoryName ? ` · ${r.categoryName}` : ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-right font-medium text-rose-600 tabular-nums">
                        −
                        <Money
                          cents={
                            r.amountCents < BigInt(0) ? r.amountCents * BigInt(-1) : r.amountCents
                          }
                          currency={r.currency}
                        />
                      </div>
                    </Link>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
