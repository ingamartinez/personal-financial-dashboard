import Link from "next/link";
import { formatMoney } from "@/lib/money";

export type CategorizationCardBodyProps = {
  pendingCount: number;
  pendingCents: bigint;
  otrosCount: number;
  otrosCents: bigint;
};

/**
 * Body of the "Categorización" amber card on /insights (#723).
 *
 * Renders up to two rows:
 *  - Row 1 (pendingCount > 0): low-confidence / unclassified txs → /settings/inbox
 *  - Row 2 (otrosCount > 0): user_uncategorized txs → /transactions?method=user_uncategorized
 *
 * When both counts are 0: renders the empty-state line.
 */
export function CategorizationCardBody({
  pendingCount,
  pendingCents,
  otrosCount,
  otrosCents,
}: CategorizationCardBodyProps) {
  if (pendingCount === 0 && otrosCount === 0) {
    return <p className="text-muted-foreground text-sm">Todo está categorizado, fantástico.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {pendingCount > 0 ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm">
            <span className="font-medium">
              {pendingCount} pendiente{pendingCount === 1 ? "" : "s"} de revisar
            </span>
            {" · "}
            {formatMoney(pendingCents, "COP")}
          </p>
          <Link
            href="/settings/inbox"
            className="shrink-0 text-xs text-amber-700 underline underline-offset-4 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
          >
            Revisar →
          </Link>
        </div>
      ) : null}
      {otrosCount > 0 ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">
            {otrosCount} marcada{otrosCount === 1 ? "" : "s"} como otros
            {" · "}
            {formatMoney(otrosCents, "COP")}
          </p>
          <Link
            href="/transactions?method=user_uncategorized"
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline underline-offset-4"
          >
            Ver →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
