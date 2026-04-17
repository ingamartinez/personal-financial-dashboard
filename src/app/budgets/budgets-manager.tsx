"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  PiggyBankIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategoryCombobox } from "@/components/transactions/category-combobox";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { deleteBudget, upsertBudget } from "./actions";

type CategoryOption = {
  slug: string;
  name: string;
  parentSlug: string | null;
};

type BudgetRow = {
  id: number;
  categorySlug: string;
  categoryName: string;
  amountCents: string;
  spentCents: string;
  currency: "COP" | "USD";
};

type EditorState = { open: boolean; editing: BudgetRow | null };

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("es-CO", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function BudgetsManager({
  ym,
  categories,
  items,
}: {
  ym: string;
  categories: CategoryOption[];
  items: BudgetRow[];
}) {
  const router = useRouter();
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    editing: null,
  });
  const [pending, startTransition] = useTransition();

  function goMonth(delta: number) {
    router.push(`/budgets?ym=${shiftMonth(ym, delta)}`);
  }

  function onDelete(row: BudgetRow) {
    if (!confirm(`Delete budget for ${row.categoryName}?`)) return;
    startTransition(async () => {
      try {
        await deleteBudget(row.id);
        toast.success("Deleted");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });
  }

  const totalBudget = items.reduce((acc, r) => acc + BigInt(r.amountCents), BigInt(0));
  const totalSpent = items.reduce((acc, r) => acc + BigInt(r.spentCents), BigInt(0));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goMonth(-1)}
            aria-label="Previous month"
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
          <div className="px-2 text-sm font-medium capitalize">{formatMonth(ym)}</div>
          <Button variant="outline" size="sm" onClick={() => goMonth(1)} aria-label="Next month">
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
        <Button onClick={() => setEditor({ open: true, editing: null })}>
          <PlusIcon className="size-4" />
          New budget
        </Button>
      </div>

      {items.length > 0 && (
        <Card>
          <CardContent className="flex items-center justify-between py-3 text-sm">
            <span className="text-muted-foreground">Total</span>
            <span className="tabular-nums">
              <span className={cn(totalSpent > totalBudget && "font-medium text-rose-600")}>
                {formatMoney(totalSpent, "COP")}
              </span>
              <span className="text-muted-foreground"> / {formatMoney(totalBudget, "COP")}</span>
            </span>
          </CardContent>
        </Card>
      )}

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PiggyBankIcon />}
            title={`No budgets for ${formatMonth(ym)}`}
            description="Set spending caps per category to track progress each month."
            action={
              <Button onClick={() => setEditor({ open: true, editing: null })}>
                <PlusIcon className="size-4" />
                New budget
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {items.map((row) => (
            <BudgetCard
              key={row.id}
              row={row}
              onEdit={() => setEditor({ open: true, editing: row })}
              onDelete={() => onDelete(row)}
              disabled={pending}
            />
          ))}
        </div>
      )}

      <BudgetEditor
        key={editor.editing?.id ?? (editor.open ? "new" : "closed")}
        open={editor.open}
        editing={editor.editing}
        ym={ym}
        categories={categories}
        existingSlugs={new Set(items.map((i) => i.categorySlug))}
        onClose={() => setEditor({ open: false, editing: null })}
      />
    </div>
  );
}

function BudgetCard({
  row,
  onEdit,
  onDelete,
  disabled,
}: {
  row: BudgetRow;
  onEdit: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const amount = BigInt(row.amountCents);
  const spent = BigInt(row.spentCents);
  const pct = amount > BigInt(0) ? Number((spent * BigInt(10000)) / amount) / 100 : 0;
  const over = spent > amount;
  const warning = pct >= 80 && !over;
  const remaining = amount - spent;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium">{row.categoryName}</div>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onEdit}
              disabled={disabled}
              aria-label="Edit"
            >
              <PencilIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={disabled}
              aria-label="Delete"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>
        <div className="bg-muted h-2 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full transition-all",
              over ? "bg-rose-600" : warning ? "bg-amber-500" : "bg-emerald-600",
            )}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-xs tabular-nums">
          <span className={cn(over ? "font-medium text-rose-600" : "text-muted-foreground")}>
            {formatMoney(spent, row.currency)} / {formatMoney(amount, row.currency)}
          </span>
          <span className={cn("text-muted-foreground", over && "font-medium text-rose-600")}>
            {over
              ? `${formatMoney(spent - amount, row.currency)} over`
              : `${formatMoney(remaining, row.currency)} left · ${pct.toFixed(0)}%`}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function BudgetEditor({
  open,
  editing,
  ym,
  categories,
  existingSlugs,
  onClose,
}: {
  open: boolean;
  editing: BudgetRow | null;
  ym: string;
  categories: CategoryOption[];
  existingSlugs: Set<string>;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const availableCategories = categories.filter(
    (c) =>
      c.parentSlug === null && (!existingSlugs.has(c.slug) || c.slug === editing?.categorySlug),
  );

  const [categorySlug, setCategorySlug] = useState(
    editing?.categorySlug ?? availableCategories[0]?.slug ?? "",
  );
  const [amount, setAmount] = useState(
    editing ? (Number(BigInt(editing.amountCents)) / 100).toString() : "",
  );
  const [currency, setCurrency] = useState<"COP" | "USD">(editing?.currency ?? "COP");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Amount must be > 0");
      return;
    }
    if (!categorySlug) {
      toast.error("Pick a category");
      return;
    }
    startTransition(async () => {
      try {
        await upsertBudget({
          id: editing?.id,
          categorySlug,
          amount: amt,
          currency,
          ym,
        });
        toast.success(editing ? "Updated" : "Created");
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
          <DialogTitle>{editing ? `Edit: ${editing.categoryName}` : "New budget"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="b-cat">Category</Label>
            <CategoryCombobox
              triggerId="b-cat"
              value={categorySlug || null}
              options={availableCategories}
              onChange={(next) => setCategorySlug(next ?? "")}
              placeholder="Pick a category"
              allowClear={false}
              rootsOnly
              disabled={!!editing}
            />
            <p className="text-muted-foreground text-xs">
              Budgets roll up sub-categories, so they live at the root level.
            </p>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="b-amount">Monthly cap</Label>
              <Input
                id="b-amount"
                type="number"
                inputMode="decimal"
                step={currency === "USD" ? "0.01" : "1"}
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                autoFocus
                className="tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="b-ccy">Currency</Label>
              <select
                id="b-ccy"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as "COP" | "USD")}
                className="bg-background h-9 rounded-md border px-2 text-sm"
              >
                <option value="COP">COP</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>

          <div className="text-muted-foreground text-xs">Period: {ym}</div>

          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
