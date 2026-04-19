"use client";

import { useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export type ColorPickerProps = {
  value: string;
  onChange: (hex: string) => void;
  id?: string;
  className?: string;
};

export function ColorPicker({ value, onChange, id, className }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const isValid = HEX_RE.test(value);
  const swatchBg = isValid ? value : "transparent";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Elegir color"
            className={cn(
              "border-input ring-ring/50 relative size-8 shrink-0 rounded-lg border transition-colors outline-none focus-visible:ring-3",
              !isValid &&
                "bg-[repeating-conic-gradient(theme(colors.muted)_0%_25%,transparent_0%_50%)_50%/8px_8px]",
            )}
            style={isValid ? { background: swatchBg } : undefined}
          />
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3" align="start">
          <HexColorPicker color={isValid ? value : "#0ea5e9"} onChange={onChange} />
        </PopoverContent>
      </Popover>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#0ea5e9"
        className="font-mono"
        maxLength={7}
        aria-invalid={value.length > 0 && !isValid}
      />
    </div>
  );
}
