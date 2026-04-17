"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, CircleXIcon, UndoIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  dismissUpcoming,
  promoteUpcoming,
  undismissUpcoming,
} from "@/app/settings/recurring/actions";
import type { UpcomingItem } from "@/lib/recurring/upcoming";

export type UpcomingCardItem = Omit<UpcomingItem, "amountCents"> & {
  amountCents: string;
};

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

const statusStyles: Record<UpcomingItem["status"], string> = {
  upcoming: "bg-sky-100 text-sky-800",
  overdue: "bg-rose-100 text-rose-800",
  matched: "bg-emerald-100 text-emerald-800",
  dismissed: "bg-muted text-muted-foreground",
};

export function UpcomingCard({
  items,
  monthLabel,
}: {
  items: UpcomingCardItem[];
  monthLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onPromote(item: UpcomingCardItem) {
    startTransition(async () => {
      try {
        await promoteUpcoming({
          recurringId: item.recurringId,
          yearMonth: item.yearMonth,
          occurredOn: item.expectedOn,
        });
        toast.success(`Imported "${item.label}"`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Promote failed");
      }
    });
  }

  function onDismiss(item: UpcomingCardItem) {
    startTransition(async () => {
      try {
        await dismissUpcoming({
          recurringId: item.recurringId,
          ym: item.yearMonth,
        });
        toast.success(`Skipped this month`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Dismiss failed");
      }
    });
  }

  function onUndismiss(item: UpcomingCardItem) {
    startTransition(async () => {
      try {
        await undismissUpcoming({
          recurringId: item.recurringId,
          ym: item.yearMonth,
        });
        toast.success("Restored");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Undismiss failed");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardDescription>Upcoming · {monthLabel}</CardDescription>
          <CardTitle className="text-lg">Recurring forecast</CardTitle>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/recurring">Manage</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            No recurring items.{" "}
            <Link href="/settings/recurring" className="underline underline-offset-2">
              Add one
            </Link>{" "}
            to start tracking.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {items.map((item) => {
              const cents = BigInt(item.amountCents);
              return (
                <li
                  key={`${item.recurringId}-${item.yearMonth}`}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <div className="text-muted-foreground flex w-12 flex-col items-center text-xs">
                    <span className="font-medium">
                      {dateFmt.format(new Date(`${item.expectedOn}T12:00:00Z`))}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{item.label}</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase",
                          statusStyles[item.status],
                        )}
                      >
                        {item.status}
                      </span>
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {item.accountName}
                      {item.categoryName ? ` · ${item.categoryName}` : ""}
                      {item.matchedTransactionId ? ` · tx #${item.matchedTransactionId}` : ""}
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
                  <div className="flex items-center gap-1">
                    {item.status === "upcoming" || item.status === "overdue" ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => onPromote(item)}
                          aria-label="Promote to transaction"
                          title="Import as real transaction"
                        >
                          <CheckCircle2Icon className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => onDismiss(item)}
                          aria-label="Dismiss this month"
                          title="Skip this month"
                        >
                          <CircleXIcon className="size-4" />
                        </Button>
                      </>
                    ) : null}
                    {item.status === "dismissed" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => onUndismiss(item)}
                        aria-label="Undismiss"
                        title="Restore this month"
                      >
                        <UndoIcon className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
