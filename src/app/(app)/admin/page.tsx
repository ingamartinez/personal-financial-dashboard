import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionUser } from "@/lib/auth/session";

const LINKS = [
  {
    href: "/admin/invites",
    title: "Invitaciones",
    description:
      "Generá códigos para que más gente pueda crear cuenta. El registro en Findash es cerrado — solo quien tiene un link válido se puede firmar.",
  },
  {
    href: "/admin/users",
    title: "Usuarios",
    description:
      "Listado de usuarios con toggle activo/inactivo y cambio de rol. Las acciones destructivas siempre dejan al menos un admin activo.",
  },
  {
    href: "/admin/health",
    title: "Salud por usuario",
    description:
      "Telemetría diaria: último SMS, último capture, fuentes activas, tasa de éxito del parser y señales de churn.",
  },
];

export default async function AdminPage() {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Admin</h1>
        <p className="text-body text-muted-foreground">
          Panel de operador. Acciones solo visibles para usuarios con rol admin.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            <Card className="hover:border-foreground/30 transition">
              <CardHeader>
                <CardTitle>{l.title}</CardTitle>
                <CardDescription>{l.description}</CardDescription>
              </CardHeader>
              <CardContent className="text-muted-foreground text-xs">{l.href} →</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
