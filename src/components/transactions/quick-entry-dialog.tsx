"use client";

import { useMemo, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createManualEntry } from "@/app/(app)/transactions/actions";
import { resolveEffectiveAccountId } from "./account-selection";
import { filterCategoriesByKind } from "./category-filter";
import type { Currency } from "@/lib/types";

export type AccountOption = {
  id: number;
  name: string;
  currency: Currency;
};

export type CategoryOption = {
  slug: string;
  name: string;
  parentSlug: string | null;
};

type EntryKind = "expense" | "income";

function todayLocalISO(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

export function QuickEntryDialog({
  accounts,
  categories,
}: {
  accounts: AccountOption[];
  categories: CategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<EntryKind>("expense");
  const defaultAccount = accounts.find((a) => a.currency === "COP") ?? accounts[0];
  const [accountId, setAccountId] = useState<string>(defaultAccount?.id.toString() ?? "");
  const effectiveAccountId = resolveEffectiveAccountId(
    accountId,
    accounts,
    defaultAccount?.id.toString(),
  );
  const selectedAccount = accounts.find((a) => a.id.toString() === effectiveAccountId);
  const currency = selectedAccount?.currency ?? "COP";
  const [amount, setAmount] = useState("");
  const [categorySlug, setCategorySlug] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayLocalISO());
  const [notes, setNotes] = useState("");

  const visibleCategories = useMemo(
    () => filterCategoriesByKind(categories, kind),
    [categories, kind],
  );

  function reset() {
    setAmount("");
    setCategorySlug("");
    setNotes("");
    setOccurredOn(todayLocalISO());
  }

  function switchKind(next: EntryKind) {
    if (next === kind) return;
    setKind(next);
    // Category lists for expense vs income don't overlap — keeping a stale
    // selection would silently send an income tx with an expense category.
    setCategorySlug("");
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveAccountId) {
      toast.error("Pick an account");
      return;
    }
    startTransition(async () => {
      try {
        await createManualEntry({
          kind,
          accountId: Number(effectiveAccountId),
          amount: amount.trim(),
          categorySlug: categorySlug || null,
          occurredOn,
          notes: notes.trim() || null,
        });
        toast.success(kind === "income" ? "Income added" : "Expense added");
        reset();
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add");
      }
    });
  }

  if (accounts.length === 0) return null;

  const triggerLabel = "Add entry";
  const submitLabel = kind === "income" ? "Add income" : "Add expense";
  const dialogTitle = kind === "income" ? "Quick income" : "Quick expense";
  const dialogDescription =
    kind === "income"
      ? "Record a deposit, reimbursement, or any cash that came in."
      : "Add a cash expense or anything not auto-imported.";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="lg"
          className="fixed right-6 bottom-6 z-30 h-14 w-14 rounded-full p-0 shadow-lg sm:w-auto sm:px-6"
          aria-label={triggerLabel}
        >
          <PlusIcon className="size-5" />
          <span className="ml-1 hidden sm:inline">Entry</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div
            role="radiogroup"
            aria-label="Entry kind"
            className="bg-muted text-muted-foreground grid grid-cols-2 rounded-md p-0.5 text-sm font-medium"
          >
            <button
              type="button"
              role="radio"
              aria-checked={kind === "expense"}
              onClick={() => switchKind("expense")}
              className={cn(
                "rounded px-3 py-1.5 transition-colors",
                kind === "expense"
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:text-foreground",
              )}
            >
              Expense
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={kind === "income"}
              onClick={() => switchKind("income")}
              className={cn(
                "rounded px-3 py-1.5 transition-colors",
                kind === "income"
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:text-foreground",
              )}
            >
              Income
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qe-amount">Amount</Label>
              <div className="relative">
                <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                  $
                </span>
                <Input
                  id="qe-amount"
                  type="number"
                  inputMode="decimal"
                  step={currency === "USD" ? "0.01" : "1"}
                  min="0"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  autoFocus
                  className="pr-14 pl-6 tabular-nums"
                />
                <span
                  className={cn(
                    "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-medium",
                    currency === "USD"
                      ? "bg-amber-500/15 text-amber-700"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {currency}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qe-date">Date</Label>
              <Input
                id="qe-date"
                type="date"
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qe-account">Account</Label>
            <select
              id="qe-account"
              value={effectiveAccountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="bg-background chevron-select h-9 rounded-md border text-sm"
              required
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatAccountLabel(a)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qe-cat">Category</Label>
            <select
              id="qe-cat"
              value={categorySlug}
              onChange={(e) => setCategorySlug(e.target.value)}
              className="bg-background chevron-select h-9 rounded-md border text-sm"
            >
              <option value="">— unclassified —</option>
              {visibleCategories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.parentSlug ? `↳ ${c.name}` : c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qe-notes">Notes</Label>
            <Input
              id="qe-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              maxLength={500}
            />
          </div>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
