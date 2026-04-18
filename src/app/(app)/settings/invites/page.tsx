import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getInviteStatus, listInviteCodesFor } from "@/lib/invite-codes";
import { InvitesManager } from "./invites-manager";
import { buildSignupUrl } from "./signup-url";

export const dynamic = "force-dynamic";

export default async function InvitesPage() {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();
  const codes = await listInviteCodesFor(session.id);
  const now = new Date();
  const invites = await Promise.all(
    codes.map(async (c) => ({
      code: c.code,
      maxUses: c.maxUses,
      usesCount: c.usesCount,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      disabledAt: c.disabledAt ? c.disabledAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
      status: getInviteStatus(c, now),
      signupUrl: await buildSignupUrl(c.code),
    })),
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Invitaciones</h1>
        <p className="text-body text-muted-foreground">
          Generá códigos de invitación para que más gente pueda crear cuenta. El registro en Findash
          es cerrado — solo quien tiene un link válido puede firmarse.
        </p>
      </header>
      <InvitesManager invites={invites} />
    </main>
  );
}
