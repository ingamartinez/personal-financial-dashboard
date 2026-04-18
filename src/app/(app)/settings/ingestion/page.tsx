import { AlertTriangleIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSessionUser } from "@/lib/auth/session";
import {
  DRIFT_CONFIG,
  getSmsHealthHistory,
  getSmsHealthSnapshot,
} from "@/lib/ingestion/sms-health";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  timeZone: "America/Bogota",
});

const timeFmt = new Intl.DateTimeFormat("es-CO", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Bogota",
});

function formatCopDate(copDate: string): string {
  const [y, m, d] = copDate.split("-").map(Number);
  // Noon UTC to avoid tz boundary issues when formatting.
  return dateFmt.format(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
}

export default async function IngestionSettingsPage() {
  const session = await getSessionUser();
  const now = new Date();
  const [snapshot, history] = await Promise.all([
    getSmsHealthSnapshot(session.id, now),
    getSmsHealthHistory(session.id, 30, now),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Ingesta</h1>
        <p className="text-body text-muted-foreground">
          Salud de la ingestión por SMS. Detecta &ldquo;días silenciosos&rdquo; cuando la
          automatización de iOS 18 falla silenciosamente.
        </p>
      </header>

      {snapshot.isDrift ? (
        <div className="flex items-start gap-3 rounded border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
          <AlertTriangleIcon className="mt-0.5 size-5 text-amber-700 dark:text-amber-300" />
          <div className="flex flex-col gap-1 text-sm">
            <div className="font-medium text-amber-900 dark:text-amber-100">
              Posible drift detectado
            </div>
            <div className="text-amber-800 dark:text-amber-200">
              Hoy ingresaron {snapshot.todayInserted} SMS, pero el promedio de los últimos 7 días es{" "}
              {snapshot.sevenDayAvgInserted.toFixed(1)}/día. Revisá la automatización de iOS y los
              logs de iMessage.
            </div>
          </div>
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Hoy (COP)</CardDescription>
            <CardTitle className="text-base">{snapshot.todayCopDate}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <Stat label="Ingresados" value={snapshot.todayInserted} />
            <Stat label="Duplicados" value={snapshot.todayDuplicated} />
            <Stat label="Descartados" value={snapshot.todaySkipped} />
            <Stat label="Con error" value={snapshot.todayError} />
            <Stat
              label="Último SMS"
              value={snapshot.lastSmsAt ? timeFmt.format(snapshot.lastSmsAt) : "—"}
            />
            <Stat label="Avg 7d" value={`${snapshot.sevenDayAvgInserted.toFixed(2)}/día`} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Configuración activa</CardDescription>
            <CardTitle className="text-base">Regla de drift</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <Stat
              label="Drift ratio"
              value={`< ${Math.round(DRIFT_CONFIG.ratio * 100)}% del avg 7d`}
            />
            <Stat
              label="Hora de corte (COP)"
              value={`≥ ${String(DRIFT_CONFIG.eveningHourCop).padStart(2, "0")}:00`}
            />
            <Stat label="Baseline mínimo" value={`${DRIFT_CONFIG.minBaseline} SMS/día`} />
            <p className="text-muted-foreground mt-2 text-xs">
              Read-only por ahora. Editable desde UI está en el issue{" "}
              <a
                href="https://github.com/ingamartinez/personal-financial-dashboard/issues/165"
                target="_blank"
                rel="noreferrer"
                className="underline hover:no-underline"
              >
                #165
              </a>
              .
            </p>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardDescription>Últimos 30 días</CardDescription>
          <CardTitle className="text-base">Historia de ingestión SMS</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <div className="text-muted-foreground text-sm">Sin ingestas registradas todavía.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead className="text-right">Ingresados</TableHead>
                  <TableHead className="text-right">Duplicados</TableHead>
                  <TableHead className="text-right">Descartados</TableHead>
                  <TableHead className="text-right">Error</TableHead>
                  <TableHead className="text-right">Último SMS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row) => (
                  <TableRow key={row.copDate}>
                    <TableCell className="font-medium">{formatCopDate(row.copDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.inserted}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.duplicated}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.skipped}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.error}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.lastSmsAt ? timeFmt.format(row.lastSmsAt) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
