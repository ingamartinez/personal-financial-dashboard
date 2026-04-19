import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SmsHealthSnapshot } from "@/lib/ingestion/sms-health";

const timeFmt = new Intl.DateTimeFormat("es-CO", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Bogota",
});

export function SmsHealthCard({ snapshot }: { snapshot: SmsHealthSnapshot }) {
  const {
    todayInserted,
    todaySkipped,
    todayDuplicated,
    todayError,
    lastSmsAt,
    sevenDayAvgInserted,
    isDrift,
  } = snapshot;

  const avgLabel = sevenDayAvgInserted > 0 ? sevenDayAvgInserted.toFixed(1) : "—";
  const lastLabel = lastSmsAt ? timeFmt.format(lastSmsAt) : "sin SMS hoy";

  const extras: Array<string | React.ReactNode> = [];
  if (todayDuplicated > 0)
    extras.push(`${todayDuplicated} duplicado${todayDuplicated === 1 ? "" : "s"}`);
  if (todaySkipped > 0) extras.push(`${todaySkipped} descartado${todaySkipped === 1 ? "" : "s"}`);
  if (todayError > 0) {
    extras.push(
      <Link
        key="error-link"
        href="/settings/inbox"
        className="text-destructive underline-offset-4 hover:underline"
      >
        {todayError} con error →
      </Link>,
    );
  }

  return (
    <Card
      className={cn(
        isDrift && "border-amber-300 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20",
      )}
    >
      <CardHeader>
        <CardDescription>Ingesta SMS · hoy</CardDescription>
        <CardTitle className="flex items-baseline gap-2 text-base">
          <span className="text-2xl font-semibold tabular-nums">{todayInserted}</span>
          <span className="text-muted-foreground text-sm font-normal">ingresados</span>
          {isDrift ? (
            <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-900 uppercase dark:bg-amber-900/60 dark:text-amber-100">
              <AlertTriangleIcon className="size-3" />
              Posible drift
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs">
        <div className="text-muted-foreground">
          Último: <span className="text-foreground">{lastLabel}</span> · avg 7d:{" "}
          <span className="text-foreground tabular-nums">{avgLabel}/día</span>
        </div>
        {extras.length > 0 ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-1">
            {extras.map((e, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                {i > 0 ? <span aria-hidden>·</span> : null}
                {e}
              </span>
            ))}
          </div>
        ) : null}
        {isDrift ? (
          <div className="text-amber-800 dark:text-amber-200">
            Muy por debajo del promedio de la última semana. Revisá la automatización de iOS.
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
