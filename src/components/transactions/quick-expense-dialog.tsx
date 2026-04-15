"use client";

import { useState, useTransition } from "react";
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
import { createManualExpense } from "@/app/transactions/actions";

export type AccountOption = {
  id: number;
  name: string;
  currency: "COP" | "USD";
};

export type CategoryOption = {
  slug: string;
  name: string;
  parentSlug: string | null;
};

function todayLocalISO(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

export function QuickExpenseDialog({
  accounts,
  categories,
}: {
  accounts: AccountOption[];
  categories: CategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const defaultAccount = accounts.find((a) => a.currency === "COP") ?? accounts[0];
  const [accountId, setAccountId] = useState<string>(
    defaultAccount?.id.toString() ?? "",
  );
  const selectedAccount = accounts.find((a) => a.id.toString() === accountId);
  const currency = selectedAccount?.currency ?? "COP";
  const [amount, setAmount] = useState("");
  const [categorySlug, setCategorySlug] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayLocalISO());
  const [notes, setNotes] = useState("");

  function reset() {
    setAmount("");
    setCategorySlug("");
    setNotes("");
    setOccurredOn(todayLocalISO());
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amtNum = Number(amount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      toast.error("Amount must be > 0");
      return;
    }
    if (!accountId) {
      toast.error("Pick an account");
      return;
    }
    startTransition(async () => {
      try {
        await createManualExpense({
          accountId: Number(accountId),
          amount: amtNum,
          categorySlug: categorySlug || null,
          occurredOn,
          notes: notes.trim() || null,
        });
        toast.success("Expense added");
        reset();
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add");
      }
    });
  }

  if (accounts.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="lg"
          className="fixed bottom-6 right-6 z-30 h-14 rounded-full shadow-lg"
          aria-label="Add expense"
        >
          <PlusIcon className="size-5" />
          <span className="ml-1">Expense</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Quick expense</DialogTitle>
          <DialogDescription>
            Add a cash expense or anything not auto-imported.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qe-amount">Amount</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
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
                  className="pl-6 pr-14 tabular-nums"
                />
                <span
                  className={cn(
                    "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-medium",
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
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              required
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
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
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">— unclassified —</option>
              {categories.map((c) => (
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
              {pending ? "Saving…" : "Add expense"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
