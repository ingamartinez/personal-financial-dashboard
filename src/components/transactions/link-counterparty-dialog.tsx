"use client";

// #683: Dialog for assigning / creating / unlinking a counterparty from the
// kebab menu. Follows the same pattern as LinkRecurringDialog (Command +
// CommandInput search + CommandList inside a Dialog).

import { useState, useTransition } from "react";
import { UserIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setTransactionCounterparty } from "@/app/(app)/transactions/actions";
import type { CounterpartyBrief, CounterpartyValue } from "@/lib/types";

export function LinkCounterpartyDialog({
  open,
  onOpenChange,
  txId,
  current,
  options,
  onAssigned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  txId: number;
  current: CounterpartyValue | null;
  options: CounterpartyBrief[];
  onAssigned?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState("");

  const trimmedSearch = search.trim();
  const sorted = [...options].sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Show "Crear «X»" only when search is non-empty AND no existing option matches exactly.
  const exactMatch = trimmedSearch
    ? options.some((o) => o.displayName.toLowerCase() === trimmedSearch.toLowerCase())
    : false;
  const showCreate = trimmedSearch.length > 0 && !exactMatch;

  function handleClose() {
    if (!pending) {
      setSearch("");
      onOpenChange(false);
    }
  }

  function handlePick(counterpartyId: number) {
    startTransition(async () => {
      const res = await setTransactionCounterparty({ txId, counterpartyId });
      if (res.status === "error") {
        toast.error(res.message);
      } else {
        toast.success("Contraparte asignada");
        setSearch("");
        onAssigned?.();
        onOpenChange(false);
      }
    });
  }

  function handleCreate(displayName: string) {
    startTransition(async () => {
      const res = await setTransactionCounterparty({
        txId,
        counterpartyId: null,
        displayName,
      });
      if (res.status === "error") {
        toast.error(res.message);
      } else {
        toast.success(`Contraparte "${displayName}" creada y asignada`);
        setSearch("");
        onAssigned?.();
        onOpenChange(false);
      }
    });
  }

  function handleUnlink() {
    startTransition(async () => {
      const res = await setTransactionCounterparty({ txId, counterpartyId: null });
      if (res.status === "error") {
        toast.error(res.message);
      } else {
        toast.success("Contraparte desvinculada");
        setSearch("");
        onAssigned?.();
        onOpenChange(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserIcon className="size-4" />
            Asignar contraparte
          </DialogTitle>
          <DialogDescription>
            Elegí una contraparte existente, creá una nueva, o desvinculá la actual.
          </DialogDescription>
        </DialogHeader>

        <Command
          className="rounded-md border"
          filter={(itemValue, s) => {
            const needle = s.toLowerCase().trim();
            if (!needle) return 1;
            return itemValue.toLowerCase().includes(needle) ? 1 : 0;
          }}
        >
          <CommandInput
            placeholder="Buscar contraparte…"
            value={search}
            onValueChange={setSearch}
            disabled={pending}
          />
          <CommandList className="max-h-48">
            <CommandEmpty>Sin resultados.</CommandEmpty>

            {/* Existing counterparties */}
            <CommandGroup>
              {sorted.map((cp) => (
                <CommandItem
                  key={cp.id}
                  value={cp.displayName}
                  disabled={pending}
                  onSelect={() => handlePick(cp.id)}
                >
                  <span className="truncate">{cp.displayName}</span>
                  {current?.id === cp.id ? (
                    <span className="text-muted-foreground ml-auto text-xs">actual</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>

            {/* Create on-the-fly */}
            {showCreate ? (
              <CommandGroup>
                <CommandItem
                  value={`__create__ ${trimmedSearch}`}
                  disabled={pending}
                  onSelect={() => handleCreate(trimmedSearch)}
                  data-testid="create-counterparty-item"
                >
                  <span className="text-muted-foreground">Crear</span>
                  <span className="ml-1 font-medium">«{trimmedSearch}»</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={pending}>
            Cancelar
          </Button>
          {current !== null ? (
            <Button variant="destructive" onClick={handleUnlink} disabled={pending}>
              {pending ? "Desvinculando…" : "Desvincular"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
