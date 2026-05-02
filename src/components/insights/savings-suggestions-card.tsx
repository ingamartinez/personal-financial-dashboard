/**
 * Savings suggestions card — C.1 CDT + C.2 FIC (Epic I, #721).
 *
 * Server component — no client interactivity needed.
 * Shows a bundled CDT + FIC table per idle savings account.
 *
 * Rendered only when idle savings are detected. Empty state: do not render.
 * Gated by canAccessFeature("cdt-suggestion") in the parent page.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCop, formatMoney } from "@/lib/money";
import type { SavingsSuggestionRow } from "@/lib/insights/savings-suggestions-queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  rows: SavingsSuggestionRow[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SavingsSuggestionsCard({ rows }: Props) {
  if (rows.length === 0) return null;

  return (
    <Card className="border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/15">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
          Optimizá tus ahorros
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {rows.map((row) => (
          <AccountSuggestionBlock key={row.accountId} row={row} />
        ))}
        <p className="text-muted-foreground text-xs">
          Estimaciones — consultá tu banco para tasas reales y condiciones.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Per-account block
// ---------------------------------------------------------------------------

function AccountSuggestionBlock({ row }: { row: SavingsSuggestionRow }) {
  // Determine display amount (native currency)
  const balanceDisplay =
    row.currency === "COP"
      ? formatCop(row.avgBalanceCents)
      : formatMoney(row.avgBalanceCents, "USD");

  const suggestedAmountCents = row.cdt?.suggestedAmountCents ?? row.fic?.suggestedAmountCents;
  const suggestedDisplay = suggestedAmountCents
    ? row.currency === "COP"
      ? formatCop(suggestedAmountCents)
      : formatMoney(suggestedAmountCents, "USD")
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
          {row.accountLabel}
        </p>
        <p className="text-muted-foreground text-sm">
          Saldo idle:{" "}
          <span className="font-medium text-emerald-800 dark:text-emerald-300">
            {balanceDisplay}
          </span>
        </p>
        {suggestedDisplay !== null && (
          <p className="text-muted-foreground text-sm">
            Monto sugerido a invertir:{" "}
            <span className="font-medium text-emerald-800 dark:text-emerald-300">
              {suggestedDisplay}
            </span>
            <span className="text-xs"> (reservando 1.5 meses de gastos)</span>
          </p>
        )}
      </div>

      {/* Tabla CDT + FIC */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-emerald-200 dark:border-emerald-800">
              <th className="pr-3 pb-1 text-left text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Producto
              </th>
              <th className="pr-3 pb-1 text-right text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Tasa anual
              </th>
              <th className="pr-3 pb-1 text-left text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Liquidez
              </th>
              <th className="pb-1 text-right text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Yield estimado
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-emerald-100 dark:divide-emerald-900">
            {/* CDT terms */}
            {row.cdt?.terms.map((term) => (
              <tr key={term.months}>
                <td className="py-1 pr-3 text-left text-emerald-900 dark:text-emerald-200">
                  CDT {term.months}M
                </td>
                <td className="py-1 pr-3 text-right text-emerald-800 tabular-nums dark:text-emerald-300">
                  {(term.ratePct * 100).toFixed(1)}%
                </td>
                <td className="py-1 pr-3 text-left text-emerald-600 dark:text-emerald-400">
                  Bloqueado {term.months} meses
                </td>
                <td className="py-1 text-right font-medium text-emerald-900 tabular-nums dark:text-emerald-200">
                  {formatCop(term.estimatedYieldCents)}
                </td>
              </tr>
            ))}

            {/* FIC row */}
            {row.fic && (
              <tr>
                <td className="py-1 pr-3 text-left text-emerald-900 dark:text-emerald-200">FIC</td>
                <td className="py-1 pr-3 text-right text-emerald-800 tabular-nums dark:text-emerald-300">
                  {row.fic.ratePct.toFixed(1)}%
                </td>
                <td className="py-1 pr-3 text-left text-emerald-600 dark:text-emerald-400">
                  Inmediata
                </td>
                <td className="py-1 text-right font-medium text-emerald-900 tabular-nums dark:text-emerald-200">
                  {formatCop(row.fic.estimatedYearlyYieldCents)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
