import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatYearMonth, shiftYearMonth } from "@/lib/date/year-month";

export function MonthSwitcher({ ym, basePath = "/" }: { ym: string; basePath?: string }) {
  const prev = shiftYearMonth(ym, -1);
  const next = shiftYearMonth(ym, 1);
  return (
    <div className="flex items-center gap-1">
      <Button asChild variant="outline" size="sm" aria-label="Mes anterior">
        <Link href={`${basePath}?ym=${prev}`} prefetch={false} scroll={false}>
          <ChevronLeftIcon className="size-4" />
        </Link>
      </Button>
      <div className="px-2 text-sm font-medium capitalize tabular-nums">{formatYearMonth(ym)}</div>
      <Button asChild variant="outline" size="sm" aria-label="Mes siguiente">
        <Link href={`${basePath}?ym=${next}`} prefetch={false} scroll={false}>
          <ChevronRightIcon className="size-4" />
        </Link>
      </Button>
    </div>
  );
}
