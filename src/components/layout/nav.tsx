"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isActive } from "./nav-items";

type NavProps = {
  orientation?: "horizontal" | "vertical";
  onNavigate?: () => void;
};

export function Nav({ orientation = "horizontal", onNavigate }: NavProps) {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        "flex gap-1",
        orientation === "horizontal" ? "flex-row items-center" : "flex-col"
      )}
    >
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-sm font-medium transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
