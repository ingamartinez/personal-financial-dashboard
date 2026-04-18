import { getSessionUser } from "@/lib/auth/session";
import { getInviteStatus, listInviteCodesFor } from "@/lib/invite-codes";
import { InvitesManager } from "./invites-manager";

export const dynamic = "force-dynamic";

function buildSignupUrl(code: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  return `${base}/signup?code=${encodeURIComponent(code)}`;
}

export default async function InvitesPage() {
  const session = await getSessionUser();
  const codes = await listInviteCodesFor(session.id);
  const now = new Date();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Invitaciones</h1>
        <p className="text-body text-muted-foreground">
          Generá códigos de invitación para que más gente pueda crear cuenta. El registro en Findash
          es cerrado — solo quien tiene un link válido puede firmarse.
        </p>
      </header>
      <InvitesManager
        invites={codes.map((c) => ({
          code: c.code,
          maxUses: c.maxUses,
          usesCount: c.usesCount,
          expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
          createdAt: c.createdAt.toISOString(),
          status: getInviteStatus(c, now),
          signupUrl: buildSignupUrl(c.code),
        }))}
      />
    </main>
  );
}
