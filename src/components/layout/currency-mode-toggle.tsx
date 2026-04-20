"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMoneyMode } from "@/components/display/money-mode-provider";
import { setDisplayCurrencyMode } from "@/lib/preferences/actions";
import { DISPLAY_CURRENCY_MODES, type DisplayCurrencyMode } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const MODE_LABEL: Record<DisplayCurrencyMode, string> = {
  native: "Native",
  "all-cop": "All COP",
  "all-usd": "All USD",
};

const MODE_DESCRIPTION: Record<DisplayCurrencyMode, string> = {
  native: "Each account in its own currency",
  "all-cop": "Convert everything to COP",
  "all-usd": "Convert everything to USD",
};

export function CurrencyModeToggle() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { mode } = useMoneyMode();

  function handleSelect(next: DisplayCurrencyMode) {
    setOpen(false);
    if (next === mode) return;
    startTransition(async () => {
      await setDisplayCurrencyMode(next);
      router.refresh();
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Currency display mode"
          className="gap-1.5"
          disabled={pending}
        >
          <ArrowLeftRightIcon className="size-4" />
          <span className="text-xs font-medium">{MODE_LABEL[mode]}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        {DISPLAY_CURRENCY_MODES.map((m) => {
          const active = m === mode;
          return (
            <Button
              key={m}
              variant="ghost"
              size="sm"
              className={cn("h-auto w-full flex-col items-start gap-0 py-2", active && "bg-accent")}
              onClick={() => handleSelect(m)}
            >
              <span className="font-medium">{MODE_LABEL[m]}</span>
              <span className="text-muted-foreground text-xs font-normal">
                {MODE_DESCRIPTION[m]}
              </span>
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
