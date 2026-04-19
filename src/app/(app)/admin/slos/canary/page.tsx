import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { canaryAlerts, parserCanaryEvents, type CanaryProjection } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const FIELD_LABELS: Record<keyof CanaryProjection, string> = {
  amountCents: "Monto (cents)",
  currency: "Moneda",
  merchant: "Merchant",
  occurredOn: "Fecha",
};

export default async function CanaryDrilldownPage() {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();

  const [disagrees, alerts] = await Promise.all([
    db
      .select({
        id: parserCanaryEvents.id,
        createdAt: parserCanaryEvents.createdAt,
        sender: parserCanaryEvents.sender,
        smsBodyHash: parserCanaryEvents.smsBodyHash,
        regexResult: parserCanaryEvents.regexResult,
        aiResult: parserCanaryEvents.aiResult,
        divergenceFields: parserCanaryEvents.divergenceFields,
        aiModel: parserCanaryEvents.aiModel,
      })
      .from(parserCanaryEvents)
      .where(eq(parserCanaryEvents.agreement, false))
      .orderBy(desc(parserCanaryEvents.createdAt))
      .limit(25),
    db.select().from(canaryAlerts).orderBy(desc(canaryAlerts.firedAt)).limit(10),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <Link href="/admin/slos" className="text-muted-foreground text-xs hover:underline">
          ← Volver a SLOs
        </Link>
        <h1 className="text-h1">AI Canary — eventos recientes</h1>
        <p className="text-body text-muted-foreground">
          Eventos donde regex y Haiku discrepan. Solo guardamos hash del SMS — los projections son
          el debugging feedback.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2">Últimos disagree ({disagrees.length})</h2>
        {disagrees.length === 0 ? (
          <p className="text-muted-foreground text-sm italic">
            No hay disagreements registrados todavía.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {disagrees.map((ev) => (
              <DisagreeCard key={ev.id} event={ev} />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2">Historial de alertas</h2>
        {alerts.length === 0 ? (
          <p className="text-muted-foreground text-sm italic">Ninguna alerta disparada todavía.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {alerts.map((a) => (
              <div
                key={a.id}
                className="border-border flex items-center justify-between rounded border px-3 py-2 text-xs"
              >
                <div className="flex flex-col">
                  <span className="font-medium">
                    {a.firedAt.toISOString()} · rate {(Number(a.rate) * 100).toFixed(1)}% ·{" "}
                    {a.samples} samples
                  </span>
                  <span className="text-muted-foreground">
                    notification: {a.notificationStatus}
                  </span>
                </div>
                <span
                  className={
                    a.resolvedAt
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-red-700 dark:text-red-400"
                  }
                >
                  {a.resolvedAt ? `resolved ${a.resolvedAt.toISOString()}` : "active"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function DisagreeCard({
  event,
}: {
  event: {
    id: number;
    createdAt: Date;
    sender: string | null;
    smsBodyHash: string;
    regexResult: CanaryProjection;
    aiResult: CanaryProjection;
    divergenceFields: string[];
    aiModel: string;
  };
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-sm">
            {event.createdAt.toISOString()} · {event.sender ?? "sender desconocido"}
          </CardTitle>
          <span className="text-muted-foreground text-[10px] tabular-nums">
            hash: {event.smsBodyHash.slice(0, 12)}… · {event.aiModel}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {event.divergenceFields.map((f) => (
            <span
              key={f}
              className="inline-flex items-center rounded bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-900 dark:bg-red-900/30 dark:text-red-200"
            >
              {FIELD_LABELS[f as keyof CanaryProjection] ?? f}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Regex</span>
            <ProjectionTable projection={event.regexResult} divergence={event.divergenceFields} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Haiku</span>
            <ProjectionTable projection={event.aiResult} divergence={event.divergenceFields} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectionTable({
  projection,
  divergence,
}: {
  projection: CanaryProjection;
  divergence: string[];
}) {
  const fields = Object.keys(FIELD_LABELS) as (keyof CanaryProjection)[];
  const div = new Set(divergence);
  return (
    <div className="border-border rounded border text-xs">
      {fields.map((f, i) => (
        <div
          key={f}
          className={
            "flex items-baseline justify-between gap-2 px-2 py-1.5 " +
            (i > 0 ? "border-border border-t " : "") +
            (div.has(f) ? "bg-red-50/60 dark:bg-red-950/20" : "")
          }
        >
          <span className="text-muted-foreground">{FIELD_LABELS[f]}</span>
          <span className="max-w-[60%] truncate text-right tabular-nums">
            {projection[f] ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}
