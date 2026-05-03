import { cn } from "@/lib/utils";
import { computeUsedPct, isHeavyUsage } from "@/lib/accounts/meter";

/**
 * Renders the visual credit-usage bar using the shared meter-track /
 * meter-fill / meter-fill-amber CSS classes. Does NOT include any surrounding
 * chrome (Card, CardHeader, Disponible/Cupo labels) — those live in the
 * parent because they vary per call-site.
 */
export function CreditMeterBar({
  limitCents,
  availableCents,
}: {
  limitCents: bigint | null;
  availableCents: bigint | null;
}) {
  const pct = computeUsedPct(limitCents, availableCents);
  const heavy = isHeavyUsage(pct);

  return (
    <div className="meter-track h-1.5">
      <div className={cn(heavy ? "meter-fill-amber" : "meter-fill")} style={{ width: `${pct}%` }} />
    </div>
  );
}
