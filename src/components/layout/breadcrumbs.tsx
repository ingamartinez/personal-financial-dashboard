"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { NAV_ITEMS } from "./nav-items";

const STATIC_LABELS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.filter((i) => i.href !== "/").map((i) => [i.href.slice(1), i.label])
);

function humanize(segment: string): string {
  const decoded = decodeURIComponent(segment).replace(/[-_]/g, " ");
  return decoded.charAt(0).toUpperCase() + decoded.slice(1);
}

export function Breadcrumbs() {
  const pathname = usePathname();
  if (pathname === "/") return null;

  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    const label = STATIC_LABELS[seg] ?? humanize(seg);
    return { href, label, isLast: i === segments.length - 1 };
  });

  return (
    <nav
      aria-label="Breadcrumb"
      className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6"
    >
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <li>
          <Link href="/" className="hover:text-foreground">
            Dashboard
          </Link>
        </li>
        {crumbs.map((c) => (
          <Fragment key={c.href}>
            <li aria-hidden className="text-muted-foreground/50">
              /
            </li>
            <li>
              {c.isLast ? (
                <span className="font-medium text-foreground" aria-current="page">
                  {c.label}
                </span>
              ) : (
                <Link href={c.href} className="hover:text-foreground">
                  {c.label}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
