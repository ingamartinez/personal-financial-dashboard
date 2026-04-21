import { getSessionUser } from "@/lib/auth/session";
import { listWidgetTokensForUser } from "@/lib/webhook-tokens";
import { WidgetCheatsheet } from "./widget-cheatsheet";
import { WidgetInstaller } from "./widget-installer";
import { WidgetTokensManager } from "./widget-tokens-manager";

export const dynamic = "force-dynamic";

export default async function WidgetsPage() {
  const session = await getSessionUser();
  const tokens = await listWidgetTokensForUser(session.id);
  // "Has any token" for the installer is "any non-revoked token" — a user
  // with only revoked tokens is effectively back to zero and the wizard
  // should still be expanded by default.
  const hasAnyToken = tokens.some((t) => !t.revokedAt);

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
      </header>
      <WidgetInstaller hasAnyToken={hasAnyToken} />
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
