"use client";

import { useState, useTransition } from "react";
import { PencilIcon, UserIcon, BuildingIcon, CircleHelpIcon } from "lucide-react";
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
import { updateCounterparty } from "@/app/transactions/actions";
import type { CategoryOption } from "./category-cell";

export type CounterpartyValue = {
  id: number;
  key: string;
  displayName: string;
  type: "person" | "merchant" | "unknown";
  defaultCategorySlug: string | null;
  notes: string | null;
};

export function CounterpartyDialog({
  counterparty,
  categories,
}: {
  counterparty: CounterpartyValue;
  categories: CategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [displayName, setDisplayName] = useState(counterparty.displayName);
  const [type, setType] = useState<CounterpartyValue["type"]>(counterparty.type);
  const [defaultCategorySlug, setDefaultCategorySlug] = useState<string>(
    counterparty.defaultCategorySlug ?? "",
  );
  const [notes, setNotes] = useState(counterparty.notes ?? "");

  const placeholderName = counterparty.displayName === counterparty.key;

  function reset() {
    setDisplayName(counterparty.displayName);
    setType(counterparty.type);
    setDefaultCategorySlug(counterparty.defaultCategorySlug ?? "");
    setNotes(counterparty.notes ?? "");
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const result = await updateCounterparty({
          id: counterparty.id,
          displayName: displayName.trim(),
          type,
          defaultCategorySlug: defaultCategorySlug || null,
          notes: notes.trim() || null,
        });
        if (result.propagatedCount > 0) {
          toast.success(
            `Counterparty updated · ${result.propagatedCount} tx recategorized`,
          );
        } else {
          toast.success("Counterparty updated");
        }
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          aria-label={
            placeholderName ? "Identify counterparty" : "Edit counterparty"
          }
        >
          {placeholderName ? (
            <>
              <CircleHelpIcon className="size-3.5" />
              <span>Identify</span>
            </>
          ) : (
            <>
              <PencilIcon className="size-3" />
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {placeholderName ? "Identify counterparty" : "Edit counterparty"}
          </DialogTitle>
          <DialogDescription>
            Key: <span className="font-mono">{counterparty.key}</span>. Setting
            a default category will recategorize all unclassified transactions
            for this counterparty.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cp-name">Display name</Label>
            <Input
              id="cp-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Panadería del Barrio"
              required
              maxLength={120}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <div className="flex gap-2">
              <TypeButton
                active={type === "person"}
                onClick={() => setType("person")}
                icon={<UserIcon className="size-3.5" />}
                label="Person"
              />
              <TypeButton
                active={type === "merchant"}
                onClick={() => setType("merchant")}
                icon={<BuildingIcon className="size-3.5" />}
                label="Merchant"
              />
              <TypeButton
                active={type === "unknown"}
                onClick={() => setType("unknown")}
                icon={<CircleHelpIcon className="size-3.5" />}
                label="Unknown"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cp-cat">Default category</Label>
            <select
              id="cp-cat"
              value={defaultCategorySlug}
              onChange={(e) => setDefaultCategorySlug(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">— none —</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.parentSlug ? `↳ ${c.name}` : c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cp-notes">Notes</Label>
            <Input
              id="cp-notes"
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
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TypeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-sm transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-muted"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
