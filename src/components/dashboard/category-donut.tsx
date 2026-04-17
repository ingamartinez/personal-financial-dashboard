"use client";

import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCop } from "@/lib/money";

const PALETTE = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)",
  "var(--chart-4)", "var(--chart-5)",
];

export type DonutSlice = {
  slug: string;
  name: string;
  color: string | null;
  value: number;
};

export function CategoryDonut({
  slices,
  monthLabel,
}: {
  slices: DonutSlice[];
  monthLabel: string;
}) {
  const total = slices.reduce((acc, s) => acc + s.value, 0);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardDescription>Expenses by category · {monthLabel}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {formatCop(BigInt(Math.round(total)))}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {slices.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            No expenses this month
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <div className="flex h-64 items-center justify-center">
              <PieChart width={210} height={210}>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={95}
                  paddingAngle={2}
                >
                  {slices.map((s, i) => (
                    <Cell
                      key={s.slug}
                      fill={s.color ?? PALETTE[i % PALETTE.length]}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) =>
                    formatCop(BigInt(Math.round(Number(value) || 0)))
                  }
                />
              </PieChart>
            </div>
            <ul className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-1.5 text-sm">
              {slices.slice(0, 8).map((s, i) => {
                const pct = total > 0 ? (s.value / total) * 100 : 0;
                return (
                  <li
                    key={s.slug}
                    className="col-span-4 grid grid-cols-subgrid items-center"
                  >
                    <span
                      className="size-3 shrink-0 rounded-sm"
                      style={{ background: s.color ?? PALETTE[i % PALETTE.length] }}
                      aria-hidden
                    />
                    <span className="truncate">{s.name}</span>
                    <span className="text-right tabular-nums text-muted-foreground">
                      {pct.toFixed(1)}%
                    </span>
                    <span className="text-right tabular-nums font-medium">
                      {formatCop(BigInt(Math.round(s.value)))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
