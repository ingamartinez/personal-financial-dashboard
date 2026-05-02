"use client";

/**
 * SpendingHeatmap — E.1 interactive heatmap cell grid.
 *
 * GitHub-contributions style: 7 rows (Sun top) × ~53 columns (weeks).
 * Color: emerald gradient (none → light → medium → high).
 * Tooltip on hover shows "$X.XXX el {weekday} {DD-MM}".
 *
 * Receives `dayBuckets` from the RSC (BigInt already serialized as string).
 */

import { useState } from "react";
import type { DayBucketSerialized, SpendBin } from "@/lib/insights/temporal";

type Props = {
  dayBuckets: DayBucketSerialized[];
};

const BIN_CLASSES: Record<SpendBin, string> = {
  none: "bg-emerald-100 dark:bg-emerald-950",
  light: "bg-emerald-300 dark:bg-emerald-800",
  medium: "bg-emerald-500 dark:bg-emerald-600",
  high: "bg-emerald-700 dark:bg-emerald-400",
};

const WEEKDAY_NAMES_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

function formatTooltip(dateStr: string, copCentsStr: string): string {
  const cents = BigInt(copCentsStr);
  // Format as COP with no decimals
  const pesos = Number(cents) / 100;
  const formatted = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(pesos);

  const d = new Date(dateStr + "T00:00:00Z");
  const weekdayName = WEEKDAY_NAMES_ES[d.getUTCDay()] ?? "";
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");

  return `${formatted} el ${weekdayName} ${day}-${month}`;
}

/**
 * Arrange dayBuckets into columns (weeks), each column being 7 days
 * starting on Sunday (DOW 0).
 *
 * Returns a 2D array: columns[colIndex][rowIndex(0=Sun..6=Sat)].
 * Cells before the first day-of-week are null (padding).
 */
function buildGrid(dayBuckets: DayBucketSerialized[]): (DayBucketSerialized | null)[][] {
  if (dayBuckets.length === 0) return [];

  const firstDay = new Date(dayBuckets[0]!.date + "T00:00:00Z");
  const firstDow = firstDay.getUTCDay(); // 0=Sun

  // Pad the beginning with null to align the first day to its DOW row
  const padded: (DayBucketSerialized | null)[] = [
    ...new Array<null>(firstDow).fill(null),
    ...dayBuckets,
  ];

  const cols: (DayBucketSerialized | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) {
    const col = padded.slice(i, i + 7);
    // Pad the last column to 7 if needed
    while (col.length < 7) col.push(null);
    cols.push(col);
  }
  return cols;
}

export function SpendingHeatmap({ dayBuckets }: Props) {
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  const cols = buildGrid(dayBuckets);

  return (
    <div className="relative">
      {/* Row labels: Sun–Sat */}
      <div className="flex gap-1">
        {/* Spacer for label column */}
        <div className="flex w-7 flex-col justify-around py-0.5">
          {(["D", "L", "M", "X", "J", "V", "S"] as const).map((label, i) => (
            // Show labels only for even rows to avoid crowding
            <span
              key={i}
              className={`text-muted-foreground h-2.5 text-[9px] leading-none ${i % 2 === 0 ? "opacity-100" : "opacity-0"}`}
            >
              {label}
            </span>
          ))}
        </div>

        {/* Grid columns */}
        <div className="flex-wrap-0 flex flex-1 gap-[2px] overflow-x-auto">
          {cols.map((col, colIdx) => (
            <div key={colIdx} className="flex flex-col gap-[2px]">
              {col.map((cell, rowIdx) =>
                cell === null ? (
                  <div key={rowIdx} className="h-2.5 w-2.5" />
                ) : (
                  <div
                    key={rowIdx}
                    className={`h-2.5 w-2.5 cursor-default rounded-[2px] transition-opacity hover:opacity-80 ${BIN_CLASSES[cell.bin]}`}
                    onMouseEnter={(e) => {
                      if (cell.bin === "none") return;
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setTooltip({
                        text: formatTooltip(cell.date, cell.copCents),
                        x: rect.left + rect.width / 2,
                        y: rect.top - 8,
                      });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                    aria-label={
                      cell.bin === "none" ? cell.date : formatTooltip(cell.date, cell.copCents)
                    }
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Floating tooltip */}
      {tooltip && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded px-2 py-1 text-xs shadow-md"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Legend */}
      <div className="text-muted-foreground mt-2 flex items-center gap-1.5 text-[10px]">
        <span>Menos</span>
        {(["none", "light", "medium", "high"] as const).map((bin) => (
          <div key={bin} className={`h-2.5 w-2.5 rounded-[2px] ${BIN_CLASSES[bin]}`} />
        ))}
        <span>Más</span>
      </div>
    </div>
  );
}
