import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { listUserHealthRows } from "@/lib/telemetry/queries";
import { HealthTable } from "./health-table";

export const dynamic = "force-dynamic";

export default async function AdminHealthPage() {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();

  const rows = await listUserHealthRows();
  const payload = rows.map((row) => ({
    ...row,
    latest: row.latest && {
      ...row.latest,
      divergenceCents: row.latest.divergenceCents?.toString() ?? null,
    },
    weekAgo: row.weekAgo && {
      ...row.weekAgo,
      divergenceCents: row.weekAgo.divergenceCents?.toString() ?? null,
    },
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Salud por usuario</h1>
        <p className="text-body text-muted-foreground">
          Telemetría diaria: último SMS, último capture, fuentes activas, tasa de éxito del parser y
          señales de churn. Habilitá alertas proactivas antes de que un usuario deje de usar la app.
        </p>
      </header>
      <HealthTable rows={payload} />
    </main>
  );
}
