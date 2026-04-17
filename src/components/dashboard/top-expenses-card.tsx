"use client";

import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useNewIds } from "@/lib/hooks/use-new-ids";
import { formatMoney } from "@/lib/money";
import type { TopExpense } from "@/lib/dashboard/queries";

const dateFmt = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short" });

export function TopExpensesCard({ rows, monthLabel }: { rows: TopExpense[]; monthLabel: string }) {
  const shouldReduceMotion = useReducedMotion();
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const newIds = useNewIds(rowIds);
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
          <div className="text-muted-foreground text-sm">No expenses this month</div>
        ) : (
          <ul className="flex flex-col divide-y">
            <AnimatePresence initial={false}>
              {rows.map((r) => {
                const isNew = newIds.has(r.id);
                return (
                  <motion.li
                    key={r.id}
                    className={cn(
                      "flex items-start justify-between gap-3 py-2 text-sm",
                      isNew && "tx-row-new",
                    )}
                    initial={enterInitial}
                    animate={enterAnimate}
                    transition={enterTransition}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.merchant ?? r.description}</div>
                      <div className="text-muted-foreground text-xs">
                        {dateFmt.format(r.occurredAt)} · {r.accountName}
                        {r.categoryName ? ` · ${r.categoryName}` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right font-medium text-rose-600 tabular-nums">
                      −
                      {formatMoney(
                        r.amountCents < BigInt(0) ? r.amountCents * BigInt(-1) : r.amountCents,
                        r.currency,
                      )}
                    </div>
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
