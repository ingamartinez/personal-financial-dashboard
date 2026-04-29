"use client";

// #621: Dialog for manually linking a transaction to a recurring forecast.
// Uses the shadcn Command/Combobox primitive (same as CategoryCombobox).

import { useState, useTransition } from "react";
import { CheckIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Money } from "@/components/display/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import { cn } from "@/lib/utils";
import { linkTxToRecurring } from "@/app/(app)/transactions/actions";
import type { RecurringOption } from "@/app/(app)/transactions/link-recurring-types";
import type { Currency } from "@/lib/types";

function RecurringPickerCombobox({
  options,
  value,
  onChange,
  disabled,
}: {
  options: RecurringOption[];
  value: number | null;
  onChange: (id: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  const displayLabel = selected ? selected.label : "Elegir recurring…";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-9 w-full justify-between font-normal",
            !value && "text-muted-foreground",
          )}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[280px] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            const needle = search.toLowerCase().trim();
            if (!needle) return 1;
            return itemValue.toLowerCase().includes(needle) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Buscar recurring…" />
          <CommandList>
            <CommandEmpty>No hay recurrings activos.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const accountLabel = formatAccountLabel({
                  name: o.accountName,
                  currency: o.accountCurrency,
                });
                const keywords = `${o.label} ${accountLabel}`.toLowerCase();
                return (
                  <CommandItem
                    key={o.id}
                    value={keywords}
                    onSelect={() => {
                      onChange(o.id);
                      setOpen(false);
                    }}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-medium">{o.label}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {accountLabel} · día {o.dayOfMonth}
                      </span>
                    </div>
                    <div className="ml-2 flex shrink-0 items-center gap-2">
                      <span className="text-sm tabular-nums">
                        <Money cents={o.amountCents} currency={o.currency as Currency} />
                      </span>
                      {value === o.id ? <CheckIcon className="size-4" /> : null}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function LinkRecurringDialog({
  open,
  onOpenChange,
  txId,
  options,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  txId: number;
  options: RecurringOption[];
  onLinked: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  function onLink() {
    if (selectedId === null) return;
    startTransition(async () => {
      const result = await linkTxToRecurring({ txId, recurringId: selectedId });
      if (result.ok) {
        toast.success("Recurring asociado", {
          description: `Mes ${result.yearMonth}`,
        });
        setSelectedId(null);
        onLinked();
        onOpenChange(false);
      } else {
        toast.error("No se pudo asociar", { description: result.error });
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setSelectedId(null);
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCwIcon className="size-4" />
            Linkear a recurring
          </DialogTitle>
          <DialogDescription>
            Seleccioná el recurring que cubre esta transacción. El mes se deriva de la fecha de la
            tx automáticamente.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <RecurringPickerCombobox
            options={options}
            value={selectedId}
            onChange={setSelectedId}
            disabled={pending}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={onLink} disabled={selectedId === null || pending}>
            {pending ? "Asociando…" : "Asociar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
