import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const LINKS = [
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
];

export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Settings</h1>
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
