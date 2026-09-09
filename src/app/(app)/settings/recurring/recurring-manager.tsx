"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/display/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import { currency as currencyEnum } from "@/lib/db/schema";
import type { Currency } from "@/lib/types";
import { cn } from "@/lib/utils";
import { archiveRecurring, toggleRecurringActive, upsertRecurring } from "./actions";

type AccountOption = { id: number; name: string; currency: Currency };
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
  currency: Currency;
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
  activeCategory,
  activeAccount = null,
  activeOnly = false,
}: {
  accounts: AccountOption[];
  categories: CategoryOption[];
  items: RecurringRow[];
  activeCategory: string | null;
  activeAccount?: number | null;
  activeOnly?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    editing: null,
  });
  const [pending, startTransition] = useTransition();

  function updateFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.push(qs ? `/settings/recurring?${qs}` : "/settings/recurring");
  }

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

  function onArchive(row: RecurringRow) {
    if (!confirm(`Archive recurring "${row.label}"?`)) return;
    startTransition(async () => {
      try {
        await archiveRecurring(row.id);
        toast.success("Archived");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={activeCategory ?? ""}
            onChange={(e) => updateFilter("category", e.target.value)}
            className="bg-background chevron-select h-9 rounded-md border text-sm"
            aria-label="Filtrar por categoría"
          >
            <option value="">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.parentSlug ? `↳ ${c.name}` : c.name}
              </option>
            ))}
          </select>
          <select
            value={activeAccount?.toString() ?? ""}
            onChange={(e) => updateFilter("account", e.target.value)}
            className="bg-background chevron-select h-9 rounded-md border text-sm"
            aria-label="Filtrar por cuenta"
          >
            <option value="">Todas las cuentas</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {formatAccountLabel(a)}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <Checkbox
              id="rec-active-only"
              checked={activeOnly}
              onCheckedChange={(checked) =>
                updateFilter("activeOnly", checked === true ? "true" : "")
              }
            />
            <Label htmlFor="rec-active-only" className="cursor-pointer text-sm font-normal">
              Solo activas
            </Label>
          </div>
        </div>
        <Button onClick={openCreate}>
          <PlusIcon className="size-4" />
          New recurring
        </Button>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
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
                <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
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
                      <tr key={r.id} className={cn("border-t", !r.active && "opacity-50")}>
                        <td className="p-2 tabular-nums">{r.dayOfMonth}</td>
                        <td className="p-2">
                          <div className="font-medium">{r.label}</div>
                          {r.notes ? (
                            <div className="text-muted-foreground text-xs">{r.notes}</div>
                          ) : null}
                        </td>
                        <td className="text-muted-foreground p-2 text-xs">{r.accountName}</td>
                        <td className="text-muted-foreground p-2 text-xs">
                          {r.categorySlug ?? "—"}
                        </td>
                        <td
                          className={cn(
                            "p-2 text-right font-medium tabular-nums",
                            cents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                          )}
                        >
                          <Money cents={cents} currency={r.currency} />
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
                              onClick={() => onArchive(r)}
                              disabled={pending}
                              aria-label="Archive"
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
    initialCents !== null ? (Math.abs(Number(initialCents)) / 100).toString() : "",
  );
  const [categorySlug, setCategorySlug] = useState(initial?.categorySlug ?? "");
  const [dayOfMonth, setDayOfMonth] = useState(initial?.dayOfMonth.toString() ?? "1");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const selectedAccount = accounts.find((a) => a.id.toString() === accountId);
  // #803: currency is independent of the linked account. It defaults to the
  // selected account's currency (or the stored row's currency when editing)
  // but the user can override it — and once they do (or when editing an
  // existing row), changing the account must not silently clobber it.
  const [currencyCode, setCurrencyCode] = useState<Currency>(
    initial?.currency ?? selectedAccount?.currency ?? "COP",
  );
  const [currencyTouched, setCurrencyTouched] = useState(Boolean(initial));

  // #803 follow-up (CRITICAL): a stale amount typed/stored in the OLD
  // currency must never survive a currency change — there is no FX
  // conversion here, so leaving it in place lets e.g. "632.7 USD" become
  // "632.7 COP" (or a rounded "633 COP") with only a step-mismatch tooltip
  // standing in the way, which the user can trivially get past. Clear the
  // amount and let the required+empty check below block submit until the
  // user re-enters it in the new currency.
  const [amountResetFor, setAmountResetFor] = useState<Currency | null>(null);

  function onAccountChange(nextAccountId: string) {
    setAccountId(nextAccountId);
    if (currencyTouched) return;
    const nextAccount = accounts.find((a) => a.id.toString() === nextAccountId);
    if (nextAccount && nextAccount.currency !== currencyCode) {
      setCurrencyCode(nextAccount.currency);
      setAmount("");
      setAmountResetFor(nextAccount.currency);
    }
  }

  function onCurrencyChange(next: Currency) {
    setCurrencyTouched(true);
    if (next !== currencyCode) {
      setAmount("");
      setAmountResetFor(next);
    }
    setCurrencyCode(next);
  }

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
          currency: currencyCode,
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
          <DialogTitle>{initial ? `Edit: ${initial.label}` : "New recurring"}</DialogTitle>
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
              <Label htmlFor="rec-amount">Amount ({currencyCode})</Label>
              <Input
                id="rec-amount"
                type="number"
                inputMode="decimal"
                step={currencyCode === "USD" ? "0.01" : "1"}
                min="0"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountResetFor(null);
                }}
                required
                aria-describedby={amountResetFor ? "rec-amount-reset-hint" : undefined}
                className="tabular-nums"
              />
              {amountResetFor ? (
                <p id="rec-amount-reset-hint" className="text-xs text-amber-600">
                  Currency changed to {amountResetFor} — re-enter the amount in {amountResetFor}.
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rec-currency">Currency</Label>
              <select
                id="rec-currency"
                value={currencyCode}
                onChange={(e) => onCurrencyChange(e.target.value as Currency)}
                className="bg-background h-9 rounded-md border px-2 text-sm"
                required
              >
                {currencyEnum.enumValues.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rec-dir">Direction</Label>
              <select
                id="rec-dir"
                value={direction}
                onChange={(e) => setDirection(e.target.value as "expense" | "income")}
                className="bg-background h-9 rounded-md border px-2 text-sm"
              >
                <option value="expense">Expense (−)</option>
                <option value="income">Income (+)</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-account">Account</Label>
            <select
              id="rec-account"
              value={accountId}
              onChange={(e) => onAccountChange(e.target.value)}
              className="bg-background h-9 rounded-md border px-2 text-sm"
              required
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatAccountLabel(a)}
                </option>
              ))}
            </select>
            {currencyTouched ? (
              <p className="text-muted-foreground text-xs">
                Currency won&apos;t change automatically — update it above if needed.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-cat">Category</Label>
            <select
              id="rec-cat"
              value={categorySlug}
              onChange={(e) => setCategorySlug(e.target.value)}
              className="bg-background h-9 rounded-md border px-2 text-sm"
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
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
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
