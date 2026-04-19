"use client";

import { useMemo, useState, type ComponentType } from "react";
import {
  Baby,
  Beer,
  BookOpen,
  Briefcase,
  Bus,
  Car,
  Coffee,
  Coins,
  CreditCard,
  Cross,
  Dog,
  Dumbbell,
  Film,
  Flame,
  Fuel,
  Gamepad2,
  Gift,
  GraduationCap,
  HandCoins,
  Hammer,
  HeartPulse,
  Home,
  Landmark,
  Laptop,
  MoreHorizontal,
  Music,
  PartyPopper,
  PawPrint,
  PiggyBank,
  Pill,
  Pizza,
  Plane,
  Plus,
  Receipt,
  Scissors,
  Shirt,
  ShoppingCart,
  Smartphone,
  Sofa,
  Sparkles,
  TrendingUp,
  Trophy,
  Utensils,
  Wallet,
  Wifi,
  Wine,
  Wrench,
  Zap,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Curated finance-relevant lucide set. Keys are the lucide kebab-case name
// so they round-trip with the existing `icon` string column.
export const CURATED_ICONS: Record<string, LucideIcon> = {
  home: Home,
  "shopping-cart": ShoppingCart,
  utensils: Utensils,
  pizza: Pizza,
  coffee: Coffee,
  wine: Wine,
  beer: Beer,
  car: Car,
  bus: Bus,
  plane: Plane,
  fuel: Fuel,
  "heart-pulse": HeartPulse,
  pill: Pill,
  cross: Cross,
  dumbbell: Dumbbell,
  "graduation-cap": GraduationCap,
  "book-open": BookOpen,
  baby: Baby,
  "paw-print": PawPrint,
  dog: Dog,
  gift: Gift,
  film: Film,
  music: Music,
  gamepad: Gamepad2,
  "party-popper": PartyPopper,
  sparkles: Sparkles,
  trophy: Trophy,
  shirt: Shirt,
  scissors: Scissors,
  briefcase: Briefcase,
  smartphone: Smartphone,
  laptop: Laptop,
  wifi: Wifi,
  zap: Zap,
  flame: Flame,
  sofa: Sofa,
  hammer: Hammer,
  wrench: Wrench,
  "piggy-bank": PiggyBank,
  "trending-up": TrendingUp,
  landmark: Landmark,
  receipt: Receipt,
  "credit-card": CreditCard,
  wallet: Wallet,
  "hand-coins": HandCoins,
  coins: Coins,
  plus: Plus,
  more: MoreHorizontal,
};

export function CategoryIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Icon = (name && CURATED_ICONS[name]) || HelpCircle;
  return <Icon className={cn("size-4", className)} />;
}

export type IconPickerProps = {
  value: string;
  onChange: (name: string) => void;
  id?: string;
};

export function IconPicker({ value, onChange, id }: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const entries = Object.entries(CURATED_ICONS);
    if (!q) return entries;
    return entries.filter(([name]) => name.includes(q));
  }, [query]);

  const Selected = (value && CURATED_ICONS[value]) as
    | ComponentType<{ className?: string }>
    | undefined;

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Elegir icono"
            className="border-input ring-ring/50 text-muted-foreground hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-lg border bg-transparent transition-colors outline-none focus-visible:ring-3"
          >
            {Selected ? <Selected className="size-4" /> : <HelpCircle className="size-4" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar icono…"
            className="border-input bg-background focus:ring-ring mb-2 h-8 w-full rounded-md border px-2 text-sm outline-none focus:ring-2"
            autoFocus
          />
          <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto">
            {filtered.map(([name, Icon]) => {
              const isSelected = name === value;
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                  className={cn(
                    "hover:bg-muted flex size-8 items-center justify-center rounded-md transition-colors",
                    isSelected && "bg-muted ring-ring ring-2",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="text-muted-foreground col-span-6 py-4 text-center text-xs">
                Sin resultados
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="home"
        className="font-mono"
      />
    </div>
  );
}
