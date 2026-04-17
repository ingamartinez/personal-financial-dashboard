import Link from "next/link";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type FiltersProps = {
  accounts: Array<{ id: number; name: string }>;
  categories: Array<{ slug: string; name: string; parentSlug: string | null }>;
  values: {
    from?: string;
    to?: string;
    accountId?: string;
    categorySlug?: string;
    q?: string;
  };
};

export function Filters({ accounts, categories, values }: FiltersProps) {
  const activeCount = [
    values.from,
    values.to,
    values.accountId,
    values.categorySlug,
    values.q,
  ].filter((v) => Boolean(v && v.length > 0)).length;
  const hasAny = activeCount > 0;

  return (
    <details open={hasAny} className="group bg-card rounded-md border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="text-muted-foreground size-4" />
          <span className="font-medium">Filters</span>
          {hasAny ? (
            <Badge variant="secondary" className="font-normal">
              {activeCount} active
            </Badge>
          ) : null}
        </div>
        <ChevronDownIcon className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
      </summary>

      <form
        method="GET"
        action="/transactions"
        className="grid grid-cols-1 gap-3 border-t p-4 sm:grid-cols-2 lg:grid-cols-6"
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            name="q"
            type="search"
            placeholder="merchant, description…"
            defaultValue={values.q ?? ""}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" name="from" type="date" defaultValue={values.from ?? ""} />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="to">To</Label>
          <Input id="to" name="to" type="date" defaultValue={values.to ?? ""} />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="accountId">Account</Label>
          <select
            id="accountId"
            name="accountId"
            defaultValue={values.accountId ?? ""}
            className="bg-background chevron-select h-9 rounded-md border text-sm"
          >
            <option value="">All</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="categorySlug">Category</Label>
          <select
            id="categorySlug"
            name="categorySlug"
            defaultValue={values.categorySlug ?? ""}
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

        <div className="flex items-end gap-2">
          <Button type="submit" className="flex-1">
            Apply
          </Button>
          {hasAny ? (
            <Button asChild type="button" variant="outline">
              <Link href="/transactions">Reset</Link>
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}
