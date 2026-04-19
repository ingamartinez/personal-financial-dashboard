import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionUser } from "@/lib/auth/session";

const LINKS = [
  {
    href: "/settings/accounts",
    title: "Accounts",
    description:
      "Create and manage savings, credit cards, and loans. Required before any transaction can land.",
  },
  {
    href: "/settings/import",
    title: "Import",
    description: "Bulk-import from XLSX or drop a screenshot for OCR.",
  },
  {
    href: "/settings/recurring",
    title: "Recurring forecast",
    description:
      "Declare expected monthly items (rent, loan, subscriptions). Shows up as upcoming on the dashboard.",
  },
  {
    href: "/settings/ingestion",
    title: "Ingesta SMS",
    description:
      "Salud de la ingestión por SMS: últimos 30 días, detección de drift y regla activa.",
  },
  {
    href: "/settings/webhooks",
    title: "Webhook tokens",
    description:
      "Per-user bearer tokens for the SMS and debug ingest endpoints. Mint, copy once, revoke when needed.",
  },
  {
    href: "/settings/telegram",
    title: "Telegram bot",
    description:
      "Register your BotFather bot. Findash encrypts the token at rest and serves the webhook at /api/telegram/webhook/<botId>.",
  },
];

const ADMIN_LINKS = [
  {
    href: "/settings/invites",
    title: "Invitaciones",
    description:
      "Generá códigos para que más gente pueda crear cuenta. El registro en Findash es cerrado — solo quien tiene un link válido se puede firmar.",
  },
  {
    href: "/settings/users",
    title: "Usuarios",
    description:
      "Listado de usuarios con toggle activo/inactivo y cambio de rol. Solo visible para admins.",
  },
];

export default async function SettingsPage() {
  const session = await getSessionUser();
  const links = session.role === "admin" ? [...LINKS, ...ADMIN_LINKS] : LINKS;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Settings</h1>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {links.map((l) => (
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
