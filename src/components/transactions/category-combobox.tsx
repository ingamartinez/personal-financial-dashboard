"use client";

import { useMemo, useState } from "react";
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
import type { CategoryOption } from "./category-cell";

type Tree = {
  root: CategoryOption;
  children: CategoryOption[];
}[];

function buildTree(options: CategoryOption[]): Tree {
  const bySlug = new Map(options.map((c) => [c.slug, c]));
  const roots = options.filter((c) => !c.parentSlug).sort((a, b) => a.name.localeCompare(b.name));
  const childrenByParent = new Map<string, CategoryOption[]>();
  for (const c of options) {
    if (!c.parentSlug) continue;
    if (!bySlug.has(c.parentSlug)) continue;
    const list = childrenByParent.get(c.parentSlug) ?? [];
    list.push(c);
    childrenByParent.set(c.parentSlug, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return roots.map((root) => ({
    root,
    children: childrenByParent.get(root.slug) ?? [],
  }));
}

function formatDisplay(
  value: string | null,
  options: CategoryOption[],
  placeholder: string,
): string {
  if (!value) return placeholder;
  const bySlug = new Map(options.map((c) => [c.slug, c]));
  const node = bySlug.get(value);
  if (!node) return placeholder;
  if (node.parentSlug) {
    const parent = bySlug.get(node.parentSlug);
    return parent ? `${parent.name} · ${node.name}` : node.name;
  }
  return node.name;
}

export function CategoryCombobox({
  value,
  options,
  onChange,
  disabled,
  placeholder = "— unclassified —",
  triggerId,
  triggerClassName,
  allowClear = true,
}: {
  value: string | null;
  options: CategoryOption[];
  onChange: (next: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  triggerId?: string;
  triggerClassName?: string;
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tree = useMemo(() => buildTree(options), [options]);
  const display = formatDisplay(value, options, placeholder);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={triggerId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-9 w-full justify-between font-normal",
            !value && "text-muted-foreground",
            triggerClassName,
          )}
        >
          <span className="truncate">{display}</span>
          <ChevronDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[220px] p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            const needle = search.toLowerCase().trim();
            if (!needle) return 1;
            return itemValue.toLowerCase().includes(needle) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search category…" />
          <CommandList>
            <CommandEmpty>No category found.</CommandEmpty>
            {allowClear ? (
              <CommandGroup>
                <CommandItem
                  value="__clear__ unclassified"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">— unclassified —</span>
                  {value === null ? <CheckIcon className="ml-auto size-4" /> : null}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {tree.map(({ root, children }) => {
              const parentKeywords = `${root.name} ${root.slug}`;
              return (
                <CommandGroup key={root.slug} heading={root.name}>
                  <CommandItem
                    value={`${parentKeywords}`}
                    onSelect={() => {
                      onChange(root.slug);
                      setOpen(false);
                    }}
                  >
                    <span>{root.name}</span>
                    {value === root.slug ? <CheckIcon className="ml-auto size-4" /> : null}
                  </CommandItem>
                  {children.map((child) => (
                    <CommandItem
                      key={child.slug}
                      value={`${child.name} ${child.slug} ${parentKeywords}`}
                      onSelect={() => {
                        onChange(child.slug);
                        setOpen(false);
                      }}
                    >
                      <span className="text-muted-foreground pl-4">↳ {child.name}</span>
                      {value === child.slug ? <CheckIcon className="ml-auto size-4" /> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
