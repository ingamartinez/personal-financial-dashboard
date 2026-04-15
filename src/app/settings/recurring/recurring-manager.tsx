"use client";

import { useState, useTransition } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  deleteRecurring,
  toggleRecurringActive,
  upsertRecurring,
} from "./actions";

type AccountOption = { id: number; name: string; currency: "COP" | "USD" };
type CategoryOption = {
  slug: string;
  name: string;
  parentSlug: string | null;
};
type RecurringRow = {
  id: number;
  accountId: number;
  accountName: string;
  label: string;
  amountCents: string;
  currency: "COP" | "USD";
  categorySlug: string | null;
  dayOfMonth: number;
  active: boolean;
  notes: string | null;
};

type EditorState = {
  open: boolean;
  editing: RecurringRow | null;
};

export function RecurringManager({
  accounts,
  categories,
  items,
}: {
  accounts: AccountOption[];
  categories: CategoryOption[];
  items: RecurringRow[];
}) {
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    editing: null,
  });
  const [pending, startTransition] = useTransition();

  function openCreate() {
    setEditor({ open: true, editing: null });
  }
  function openEdit(row: RecurringRow) {
    setEditor({ open: true, editing: row });
  }
  function close() {
    setEditor({ open: false, editing: null });
  }

  function onToggle(row: RecurringRow) {
    startTransition(async () => {
      try {
        await toggleRecurringActive(row.id, !row.active);
        toast.success(row.active ? "Paused" : "Activated");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  function onDelete(row: RecurringRow) {
    if (!confirm(`Delete recurring "${row.label}"? This cannot be undone.`))
      return;
    startTransition(async () => {
      try {
        await deleteRecurring(row.id);
        toast.success("Deleted");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <PlusIcon className="size-4" />
          New recurring
        </Button>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <p>No recurring items yet.</p>
            <p>Add your rent, loan payment, and monthly subscriptions.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {items.length} item{items.length !== 1 ? "s" : ""} ·{" "}
              {items.filter((r) => r.active).length} active
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">Day</th>
                    <th className="p-2 text-left">Label</th>
                    <th className="p-2 text-left">Account</th>
                    <th className="p-2 text-left">Category</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const cents = BigInt(r.amountCents);
                    return (
                      <tr
                        key={r.id}
                        className={cn("border-t", !r.active && "opacity-50")}
                      >
                        <td className="p-2 tabular-nums">{r.dayOfMonth}</td>
                        <td className="p-2">
                          <div className="font-medium">{r.label}</div>
                          {r.notes ? (
                            <div className="text-xs text-muted-foreground">
                              {r.notes}
                            </div>
                          ) : null}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {r.accountName}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {r.categorySlug ?? "—"}
                        </td>
                        <td
                          className={cn(
                            "p-2 text-right tabular-nums font-medium",
                            cents < BigInt(0)
                              ? "text-rose-600"
                              : "text-emerald-600",
                          )}
                        >
                          {formatMoney(cents, r.currency)}
                        </td>
                        <td className="p-2 text-xs">
                          <button
                            type="button"
                            onClick={() => onToggle(r)}
                            disabled={pending}
                            className={cn(
                              "rounded px-1.5 py-0.5",
                              r.active
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {r.active ? "active" : "paused"}
                          </button>
                        </td>
                        <td className="p-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(r)}
                              disabled={pending}
                              aria-label="Edit"
                            >
                              <PencilIcon className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onDelete(r)}
                              disabled={pending}
                              aria-label="Delete"
                            >
                              <Trash2Icon className="size-4" />
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
        </Card>
      )}

      <RecurringEditor
        key={editor.editing?.id ?? (editor.open ? "new" : "closed")}
        open={editor.open}
        editing={editor.editing}
        accounts={accounts}
        categories={categories}
        onClose={close}
      />
    </div>
  );
}

function RecurringEditor({
  open,
  editing,
  accounts,
  categories,
  onClose,
}: {
  open: boolean;
  editing: RecurringRow | null;
  accounts: AccountOption[];
  categories: CategoryOption[];
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const initial = editing;
  const initialCents = initial ? BigInt(initial.amountCents) : null;

  const [accountId, setAccountId] = useState(
    initial?.accountId.toString() ?? accounts[0]?.id.toString() ?? "",
  );
  const [label, setLabel] = useState(initial?.label ?? "");
  const [direction, setDirection] = useState<"expense" | "income">(
    initialCents !== null && initialCents >= BigInt(0) ? "income" : "expense",
  );
  const [amount, setAmount] = useState(
    initialCents !== null
      ? (
          Math.abs(Number(initialCents)) / 100
        ).toString()
      : "",
  );
  const [categorySlug, setCategorySlug] = useState(initial?.categorySlug ?? "");
  const [dayOfMonth, setDayOfMonth] = useState(
    initial?.dayOfMonth.toString() ?? "1",
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const selectedAccount = accounts.find((a) => a.id.toString() === accountId);
  const currency = selectedAccount?.currency ?? "COP";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amtNum = Number(amount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      toast.error("Amount must be > 0");
      return;
    }
    const dayNum = Number(dayOfMonth);
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) {
      toast.error("Day must be 1–31");
      return;
    }
    startTransition(async () => {
      try {
        await upsertRecurring({
          id: initial?.id,
          accountId: Number(accountId),
          label: label.trim(),
          amount: amtNum,
          direction,
          categorySlug: categorySlug || null,
          dayOfMonth: dayNum,
          active: initial?.active ?? true,
          notes: notes.trim() || null,
        });
        toast.success(initial ? "Updated" : "Created");
        onClose();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial ? `Edit: ${initial.label}` : "New recurring"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-label">Label</Label>
            <Input
              id="rec-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Cuota préstamo consolidado"
              required
              maxLength={120}
              autoFocus={!initial}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rec-amount">Amount ({currency})</Label>
              <Input
                id="rec-amount"
                type="number"
                inputMode="decimal"
                step={currency === "USD" ? "0.01" : "1"}
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                className="tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rec-day">Day of month</Label>
              <Input
                id="rec-day"
                type="number"
                min="1"
                max="31"
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
                required
                className="tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rec-dir">Direction</Label>
              <select
                id="rec-dir"
                value={direction}
                onChange={(e) =>
                  setDirection(e.target.value as "expense" | "income")
                }
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="expense">Expense (−)</option>
                <option value="income">Income (+)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rec-account">Account</Label>
              <select
                id="rec-account"
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
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-cat">Category</Label>
            <select
              id="rec-cat"
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
            <Label htmlFor="rec-notes">Notes</Label>
            <Input
              id="rec-notes"
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
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : initial ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
