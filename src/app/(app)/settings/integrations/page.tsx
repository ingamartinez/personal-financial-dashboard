import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { GmailCard, type GmailCardState } from "./gmail-card";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string }>;
}) {
  const session = await getSessionUser();
  const params = await searchParams;

  const [row] = await db
    .select({
      id: gmailConnections.id,
      gmailEmail: gmailConnections.gmailEmail,
      status: gmailConnections.status,
      statusReason: gmailConnections.statusReason,
      lastPullAt: gmailConnections.lastPullAt,
      bootstrapSinceDate: gmailConnections.bootstrapSinceDate,
      createdAt: gmailConnections.createdAt,
    })
    .from(gmailConnections)
    .where(and(eq(gmailConnections.userId, session.id), notDeleted(gmailConnections.deletedAt)))
    .limit(1);

  const state: GmailCardState = row
    ? {
        kind: "connected",
        connection: {
          gmailEmail: row.gmailEmail,
          status: row.status,
          statusReason: row.statusReason,
          lastPullAt: row.lastPullAt ? row.lastPullAt.toISOString() : null,
          bootstrapSinceDate: row.bootstrapSinceDate ? row.bootstrapSinceDate.toISOString() : null,
          connectedAt: row.createdAt.toISOString(),
        },
      }
    : { kind: "disconnected" };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Integrations</h1>
        <p className="text-body text-muted-foreground">
          Conectá cuentas externas para que Findash enriquezca transacciones de gateways (Mercado
          Pago, PayU, Wompi, etc.) y pueda pullear emails de banco directamente — sin depender de
          que llegue el SMS.
        </p>
      </header>
      <GmailCard state={state} feedback={params.gmail ?? null} />
    </main>
  );
}
