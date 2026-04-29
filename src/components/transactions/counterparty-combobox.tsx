"use client";

import { useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CounterpartyBrief } from "@/lib/types";

export function CounterpartyCombobox({
  value,
  options,
  onPick,
  onCreate,
  onUnlink,
  disabled,
}: {
  value: { id: number; displayName: string } | null;
  options: CounterpartyBrief[];
  onPick: (id: number) => void;
  onCreate: (displayName: string) => void;
  onUnlink: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const sorted = [...options].sort((a, b) => a.displayName.localeCompare(b.displayName));

  const trimmedSearch = search.trim();

  // Show "+ Crear nuevo" only when search is non-empty AND no existing option
  // matches exactly (case-insensitive).
  const exactMatch = trimmedSearch
    ? options.some((o) => o.displayName.toLowerCase() === trimmedSearch.toLowerCase())
    : false;
  const showCreate = trimmedSearch.length > 0 && !exactMatch;

  const displayLabel = value?.displayName ?? "Sin asignar";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-7 w-full justify-between text-xs font-normal",
            !value && "text-muted-foreground",
          )}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDownIcon className="ml-1 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[220px] p-0" align="start">
        <Command
          filter={(itemValue, s) => {
            const needle = s.toLowerCase().trim();
            if (!needle) return 1;
            return itemValue.toLowerCase().includes(needle) ? 1 : 0;
          }}
        >
          <CommandInput
            placeholder="Buscar counterparty…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>Sin resultados.</CommandEmpty>

            {/* Existing counterparties */}
            <CommandGroup>
              {sorted.map((cp) => (
                <CommandItem
                  key={cp.id}
                  value={cp.displayName}
                  onSelect={() => {
                    onPick(cp.id);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{cp.displayName}</span>
                  {value?.id === cp.id ? <CheckIcon className="ml-auto size-4" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>

            {/* Bottom group: create + unlink */}
            <CommandGroup>
              {showCreate ? (
                <CommandItem
                  value={`__create__ ${trimmedSearch}`}
                  onSelect={() => {
                    onCreate(trimmedSearch);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">+ Crear nuevo: </span>
                  <span className="ml-1 font-medium">{trimmedSearch}</span>
                </CommandItem>
              ) : null}
              {value !== null ? (
                <CommandItem
                  value="__unlink__ sin asignar"
                  onSelect={() => {
                    onUnlink();
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">Sin asignar</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
