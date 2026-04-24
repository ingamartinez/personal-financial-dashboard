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
    href: "/settings/categories",
    title: "Categorías",
    description:
      "Tu taxonomía personal: agregá, renombrá o archivá categorías. Cada usuario tiene la suya.",
  },
  {
    href: "/settings/rules",
    title: "Reglas de clasificación",
    description:
      "Patrones ILIKE que auto-categorizan transacciones antes del fallback con IA. Manuales y auto-generadas por el learning loop.",
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
    href: "/settings/inbox",
    title: "Ingestion inbox",
    description:
      "SMS que fallaron al rutear. Reintentalos con la cuenta correcta o descartalos — nada se pierde en silencio.",
  },
  {
    href: "/settings/webhooks",
    title: "Webhook tokens",
    description:
      "Per-user bearer tokens for the SMS and debug ingest endpoints. Mint, copy once, revoke when needed.",
  },
  {
    href: "/settings/widgets",
    title: "Widgets",
    description:
      "Tokens y cheatsheet para los widgets de pantalla de inicio (Scriptable / Tasker). Generá, copiá una vez, revocá cuando quieras.",
  },
  {
    href: "/settings/telegram",
    title: "Telegram bot",
    description:
      "Register your BotFather bot. Findash encrypts the token at rest and serves the webhook at /api/telegram/webhook/<botId>.",
  },
  {
    href: "/settings/integrations",
    title: "Integrations",
    description:
      "Connect external accounts (Gmail, etc.) so Findash can enrich gateway transactions and pull bank receipts directly from your inbox.",
  },
  {
    href: "/settings/snapshots",
    title: "Snapshots",
    description:
      "Save and restore your transactional data. Useful before a reset or a mass email ingestion — keeps accounts, categories, rules, and integrations untouched.",
  },
];

const ADMIN_LINK = {
  href: "/admin",
  title: "Admin",
  description:
    "Panel de operador: invitaciones, usuarios, salud por usuario. Solo visible para admins.",
};

export default async function SettingsPage() {
  const session = await getSessionUser();
  const links = session.role === "admin" ? [...LINKS, ADMIN_LINK] : LINKS;
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
