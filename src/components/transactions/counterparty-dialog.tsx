"use client";

import { useState, useTransition } from "react";
import {
  PencilIcon,
  UserIcon,
  BuildingIcon,
  CircleHelpIcon,
  MergeIcon,
  SplitIcon,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  updateCounterparty,
  mergeCounterparty,
  splitCounterparty,
} from "@/app/transactions/actions";
import type { CategoryOption } from "./category-cell";
import { CategoryCombobox } from "./category-combobox";

export type CounterpartyAlias = {
  id: number;
  kind: "qr" | "breb" | "account" | "name";
  value: string;
};

export type CounterpartyValue = {
  id: number;
  displayName: string;
  type: "person" | "merchant" | "unknown";
  defaultCategorySlug: string | null;
  notes: string | null;
  aliases: CounterpartyAlias[];
};

export type CounterpartyBrief = {
  id: number;
  displayName: string;
  type: "person" | "merchant" | "unknown";
};

const ALIAS_KIND_LABELS: Record<CounterpartyAlias["kind"], string> = {
  qr: "QR",
  breb: "Bre-b",
  account: "Cuenta",
  name: "Nombre",
};

function isPlaceholderName(cp: CounterpartyValue): boolean {
  // Placeholder means the display_name still equals one of the raw alias
  // values (the initial seed when nothing was renamed yet). "Cuenta *NNNN"
  // style initialDisplayName is also considered placeholder via prefix match.
  if (cp.aliases.some((a) => a.value === cp.displayName)) return true;
  if (cp.aliases.some((a) => a.kind === "account" && cp.displayName === `Cuenta *${a.value}`))
    return true;
  return false;
}

export function CounterpartyDialog({
  counterparty,
  categories,
  allCounterparties,
}: {
  counterparty: CounterpartyValue;
  categories: CategoryOption[];
  allCounterparties: CounterpartyBrief[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [displayName, setDisplayName] = useState(counterparty.displayName);
  const [type, setType] = useState<CounterpartyValue["type"]>(counterparty.type);
  const [defaultCategorySlug, setDefaultCategorySlug] = useState<string>(
    counterparty.defaultCategorySlug ?? "",
  );
  const [notes, setNotes] = useState(counterparty.notes ?? "");
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [splitAliasIds, setSplitAliasIds] = useState<Set<number>>(() => new Set());

  const placeholderName = isPlaceholderName(counterparty);
  const mergeCandidates = allCounterparties.filter((c) => c.id !== counterparty.id);
  const canSplit = counterparty.aliases.length >= 2;
  const splitSelectedCount = splitAliasIds.size;
  const splitValid = splitSelectedCount > 0 && splitSelectedCount < counterparty.aliases.length;

  function reset() {
    setDisplayName(counterparty.displayName);
    setType(counterparty.type);
    setDefaultCategorySlug(counterparty.defaultCategorySlug ?? "");
    setNotes(counterparty.notes ?? "");
    setMergeTargetId("");
    setSplitAliasIds(new Set());
  }

  function toggleSplitAlias(id: number) {
    setSplitAliasIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          toast.success(`Counterparty updated · ${result.propagatedCount} tx recategorized`);
        } else {
          toast.success("Counterparty updated");
        }
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    });
  }

  function onSplit() {
    if (!splitValid) return;
    const extracted = counterparty.aliases.filter((a) => splitAliasIds.has(a.id));
    const confirmed = window.confirm(
      `Split ${extracted.length} alias${extracted.length === 1 ? "" : "es"} out of ` +
        `"${counterparty.displayName}" into a new counterparty?\n\n` +
        `Historical transactions matching the extracted aliases will be reassigned ` +
        `to the new counterparty. You can rename it afterwards.`,
    );
    if (!confirmed) return;
    startTransition(async () => {
      try {
        const result = await splitCounterparty({
          sourceId: counterparty.id,
          aliasIds: Array.from(splitAliasIds),
        });
        toast.success(
          `Split · ${result.movedAliasCount} alias${result.movedAliasCount === 1 ? "" : "es"} + ` +
            `${result.movedTxCount} tx moved to new counterparty`,
        );
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Split failed");
      }
    });
  }

  function onMerge() {
    const targetId = Number(mergeTargetId);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      toast.error("Pick a target counterparty");
      return;
    }
    const target = mergeCandidates.find((c) => c.id === targetId);
    if (!target) return;
    const confirmed = window.confirm(
      `Merge "${counterparty.displayName}" into "${target.displayName}"?\n\n` +
        `All aliases and transactions will move to "${target.displayName}". ` +
        `"${counterparty.displayName}" will be deleted.`,
    );
    if (!confirmed) return;
    startTransition(async () => {
      try {
        const result = await mergeCounterparty({
          sourceId: counterparty.id,
          targetId,
        });
        toast.success(`Merged · ${result.movedTxCount} tx moved to "${target.displayName}"`);
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Merge failed");
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
          aria-label={placeholderName ? "Identify counterparty" : "Edit counterparty"}
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader className="min-w-0">
          <DialogTitle>
            {placeholderName ? "Identify counterparty" : "Edit counterparty"}
          </DialogTitle>
          <DialogDescription>
            Setting a default category will recategorize all unclassified transactions for this
            counterparty.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Aliases</Label>
            <div className="flex flex-wrap gap-1.5">
              {counterparty.aliases.map((a) => (
                <span
                  key={`${a.kind}:${a.value}`}
                  className="bg-muted/50 text-muted-foreground inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs"
                >
                  <span className="font-sans uppercase">{ALIAS_KIND_LABELS[a.kind]}</span>
                  <span>{a.value}</span>
                </span>
              ))}
            </div>
          </div>

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
            <CategoryCombobox
              triggerId="cp-cat"
              value={defaultCategorySlug || null}
              options={categories}
              onChange={(next) => setDefaultCategorySlug(next ?? "")}
              placeholder="— none —"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cp-notes">Notes</Label>
            <Textarea
              id="cp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              maxLength={500}
              rows={2}
              className="field-sizing-fixed min-h-0 resize-none"
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

        {mergeCandidates.length > 0 ? (
          <div className="mt-2 flex min-w-0 flex-col gap-1.5 border-t pt-3">
            <Label htmlFor="cp-merge">Merge into</Label>
            <p className="text-muted-foreground text-xs">
              Use this if another counterparty is the same person or merchant. All aliases and
              transactions move to the target.
            </p>
            <div className="flex min-w-0 gap-2">
              <select
                id="cp-merge"
                value={mergeTargetId}
                onChange={(e) => setMergeTargetId(e.target.value)}
                className="bg-background chevron-select h-9 w-full min-w-0 flex-1 rounded-md border text-sm"
                disabled={pending}
              >
                <option value="">— pick target —</option>
                {mergeCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                onClick={onMerge}
                disabled={pending || !mergeTargetId}
              >
                <MergeIcon className="size-3.5" />
                Merge
              </Button>
            </div>
          </div>
        ) : null}

        {canSplit ? (
          <div className="mt-2 flex min-w-0 flex-col gap-1.5 border-t pt-3">
            <Label>Split out aliases</Label>
            <p className="text-muted-foreground text-xs">
              Select aliases to extract into a new counterparty. Transactions matching those aliases
              will move with them.
            </p>
            <div className="flex flex-col gap-1">
              {counterparty.aliases.map((a) => {
                const checked = splitAliasIds.has(a.id);
                return (
                  <label
                    key={a.id}
                    className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSplitAlias(a.id)}
                      disabled={pending}
                      className="size-3.5"
                    />
                    <span className="text-muted-foreground font-sans uppercase">
                      {ALIAS_KIND_LABELS[a.kind]}
                    </span>
                    <span className="font-mono">{a.value}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                {splitSelectedCount === 0
                  ? "Pick at least one alias"
                  : splitSelectedCount >= counterparty.aliases.length
                    ? "At least one alias must stay"
                    : `${splitSelectedCount} selected`}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={onSplit}
                disabled={pending || !splitValid}
              >
                <SplitIcon className="size-3.5" />
                Split
              </Button>
            </div>
          </div>
        ) : null}
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
