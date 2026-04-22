"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDownIcon, Loader2Icon, SlidersHorizontalIcon } from "lucide-react";
import { formatAccountLabel } from "@/lib/accounts/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SEARCH_DEBOUNCE_MS = 300;

export type FiltersProps = {
  accounts: Array<{ id: number; name: string; currency: string }>;
  categories: Array<{ slug: string; name: string; parentSlug: string | null }>;
};

export function Filters({ accounts, categories }: FiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentQ = searchParams.get("q") ?? "";
  const currentFrom = searchParams.get("from") ?? "";
  const currentTo = searchParams.get("to") ?? "";
  const currentAccountId = searchParams.get("accountId") ?? "";
  const currentCategorySlug = searchParams.get("categorySlug") ?? "";
  const showAdjustmentsActive = Boolean(searchParams.get("showAdjustments"));
  const showArchivedActive = Boolean(searchParams.get("showArchived"));
  const needsRateActive = Boolean(searchParams.get("needsRate"));

  // Local mirror for the text search so every keystroke stays snappy; we push
  // the URL (and therefore the DB query) only after SEARCH_DEBOUNCE_MS of idle.
  const [q, setQ] = useState(currentQ);

  // Keep the local mirror in sync when the URL changes externally — Reset,
  // back/forward, or a link from another page.
  useEffect(() => {
    setQ(currentQ);
  }, [currentQ]);

  useEffect(() => {
    if (q === currentQ) return;
    const handle = setTimeout(() => {
      applyChange("q", q);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, currentQ]);

  function applyChange(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the cursor — its anchor row might no longer
    // match the new predicate, so we always reset to page 1.
    next.delete("cursor");
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `/transactions?${qs}` : "/transactions", { scroll: false });
    });
  }

  function reset() {
    setQ("");
    startTransition(() => {
      router.replace("/transactions", { scroll: false });
    });
  }

  const stringActive = [
    currentFrom,
    currentTo,
    currentAccountId,
    currentCategorySlug,
    currentQ,
  ].filter((v) => v.length > 0).length;
  const activeCount =
    stringActive +
    (showAdjustmentsActive ? 1 : 0) +
    (showArchivedActive ? 1 : 0) +
    (needsRateActive ? 1 : 0);
  const hasAny = activeCount > 0;

  return (
    <details open={hasAny} aria-busy={isPending} className="group bg-card rounded-md border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="text-muted-foreground size-4" />
          <span className="font-medium">Filters</span>
          {hasAny ? (
            <Badge variant="secondary" className="font-normal">
              {activeCount} active
            </Badge>
          ) : null}
          {isPending ? (
            <Loader2Icon
              className="text-muted-foreground size-4 animate-spin"
              aria-label="Updating"
            />
          ) : null}
        </div>
        <ChevronDownIcon className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
      </summary>

      <div className="grid grid-cols-1 gap-3 border-t p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="flex flex-col gap-1">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            type="search"
            placeholder="merchant, description…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            value={currentFrom}
            onChange={(e) => applyChange("from", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            value={currentTo}
            onChange={(e) => applyChange("to", e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="accountId">Account</Label>
          <select
            id="accountId"
            value={currentAccountId}
            onChange={(e) => applyChange("accountId", e.target.value)}
            className="bg-background chevron-select h-9 rounded-md border text-sm"
          >
            <option value="">All</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {formatAccountLabel(a)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="categorySlug">Category</Label>
          <select
            id="categorySlug"
            value={currentCategorySlug}
            onChange={(e) => applyChange("categorySlug", e.target.value)}
            className="bg-background chevron-select h-9 rounded-md border text-sm"
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.parentSlug ? `↳ ${c.name}` : c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end">
          {hasAny ? (
            <Button type="button" variant="outline" onClick={reset} className="flex-1">
              Clear filters
            </Button>
          ) : null}
        </div>

        <label
          htmlFor="showAdjustments"
          className="flex cursor-pointer items-center gap-2 text-sm sm:col-span-2 lg:col-span-6"
        >
          <input
            id="showAdjustments"
            type="checkbox"
            checked={showAdjustmentsActive}
            onChange={(e) => applyChange("showAdjustments", e.target.checked ? "on" : "")}
            className="border-input size-4 rounded border"
          />
          <span>Show balance adjustments</span>
          <span className="text-muted-foreground text-xs">
            (hidden by default — reconciliation entries, not spend)
          </span>
        </label>

        <label
          htmlFor="showArchived"
          className="flex cursor-pointer items-center gap-2 text-sm sm:col-span-2 lg:col-span-6"
        >
          <input
            id="showArchived"
            type="checkbox"
            checked={showArchivedActive}
            onChange={(e) => applyChange("showArchived", e.target.checked ? "on" : "")}
            className="border-input size-4 rounded border"
          />
          <span>Show archived</span>
          <span className="text-muted-foreground text-xs">
            (hidden by default — archived transactions are excluded from balance and reports)
          </span>
        </label>

        <label
          htmlFor="needsRate"
          className="flex cursor-pointer items-center gap-2 text-sm sm:col-span-2 lg:col-span-6"
        >
          <input
            id="needsRate"
            type="checkbox"
            checked={needsRateActive}
            onChange={(e) => applyChange("needsRate", e.target.checked ? "on" : "")}
            className="border-input size-4 rounded border"
          />
          <span>Only TC purchases needing rate</span>
          <span className="text-muted-foreground text-xs">
            (multi-cuota without an explicit EM — fill from the month&apos;s extract)
          </span>
        </label>
      </div>
    </details>
  );
}
