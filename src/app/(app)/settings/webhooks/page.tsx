import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSessionUser } from "@/lib/auth/session";
import { listWebhookTokensForUser } from "@/lib/webhook-tokens";
import { IosGotchaBanner } from "./ios-gotcha-banner";
import { IosShortcutCard } from "./ios-shortcut-card";
import { IosTroubleshooting } from "./ios-troubleshooting";
import { IosVideoDemo } from "./ios-video-demo";
import { WebhookTokensManager } from "./webhook-tokens-manager";

export const dynamic = "force-dynamic";

// Pulled from disk once per render — if the file lands later, no code change
// needed to light up the embedded player.
const VIDEO_FILE = "ios-shortcut/onboarding.mp4";
const POSTER_FILE = "ios-shortcut/onboarding-poster.jpg";

function publicAssetUrl(relative: string): string | null {
  const abs = join(process.cwd(), "public", relative);
  return existsSync(abs) ? `/${relative}` : null;
}

export default async function WebhooksPage() {
  const session = await getSessionUser();
  const tokens = await listWebhookTokensForUser(session.id);
  const videoUrl = publicAssetUrl(VIDEO_FILE);
  const posterUrl = publicAssetUrl(POSTER_FILE) ?? undefined;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Webhook tokens</h1>
        <p className="text-body text-muted-foreground">
          Per-user bearer tokens for the ingest webhooks ({" "}
          <code className="font-mono">/api/ingest/sms</code>,{" "}
          <code className="font-mono">/api/ingest/debug</code>). Mint one per device or automation
          (the iPhone Shortcut, a debug client, etc.). The plaintext value is shown{" "}
          <strong>once</strong> at mint time — store it before leaving the page.
        </p>
      </header>
      <IosGotchaBanner />
      <WebhookTokensManager
        tokens={tokens.map((t) => ({
          id: t.id,
          purpose: t.purpose,
          label: t.label,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
          revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
        }))}
      />
      <IosVideoDemo videoUrl={videoUrl} posterUrl={posterUrl} />
      <IosShortcutCard />
      <IosTroubleshooting />
    </main>
  );
}
