import type { TrendPoint } from "@/lib/telemetry/slos";

const WIDTH = 240;
const HEIGHT = 40;

export function Sparkline({ points }: { points: TrendPoint[] }) {
  const numericValues = points
    .map((p) => p.value)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  if (numericValues.length === 0) {
    return <p className="text-muted-foreground text-[11px] italic">Sin datos en la ventana.</p>;
  }

  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  const range = max - min || 1;
  const step = WIDTH / Math.max(points.length - 1, 1);

  // Build the path — skip null gaps by lifting the pen (`M` after a gap).
  let d = "";
  let prevWasNull = true;
  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) {
      prevWasNull = true;
      return;
    }
    const x = i * step;
    const y = HEIGHT - ((p.value - min) / range) * HEIGHT;
    d += `${prevWasNull ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)} `;
    prevWasNull = false;
  });

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width="100%"
      height={HEIGHT}
      preserveAspectRatio="none"
      className="text-foreground/70"
      role="img"
      aria-label={`Sparkline trend con ${numericValues.length} puntos`}
    >
      <path d={d.trim()} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
