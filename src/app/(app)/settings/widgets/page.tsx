import { ExternalLink } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { listWidgetTokensForUser } from "@/lib/webhook-tokens";
import { WidgetCheatsheet } from "./widget-cheatsheet";
import { WidgetTokensManager } from "./widget-tokens-manager";

export const dynamic = "force-dynamic";

const SETUP_GUIDE_URL =
  "https://github.com/ingamartinez/personal-financial-dashboard/blob/main/docs/widgets/README.md";

export default async function WidgetsPage() {
  const session = await getSessionUser();
  const tokens = await listWidgetTokensForUser(session.id);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="text-h1">Widgets</h1>
          <p className="text-body text-muted-foreground">
            Tokens per-usuario para alimentar los widgets de pantalla de inicio (Scriptable en iOS,
            Tasker en Android). Cada token habilita el endpoint{" "}
            <code className="font-mono">/api/widget/v1/&lt;id&gt;</code>. El plaintext se muestra{" "}
            <strong>una sola vez</strong> al generarlo — guardalo antes de salir.
          </p>
        </div>
        <a
          href={SETUP_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:text-primary/80 inline-flex w-fit items-center gap-1.5 text-sm font-medium underline underline-offset-4"
        >
          <span aria-hidden>📱</span>
          Guía de configuración (iOS + Android)
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </header>
      <WidgetTokensManager
        tokens={tokens.map((t) => ({
          id: t.id,
          label: t.label,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
          revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
        }))}
      />
      <WidgetCheatsheet />
    </main>
  );
}
