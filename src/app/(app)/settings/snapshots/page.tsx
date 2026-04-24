import { getSessionUser } from "@/lib/auth/session";
import { listSnapshots } from "@/lib/snapshots/queries";
import { SnapshotsManager, type SnapshotRow } from "./snapshots-manager";

export const dynamic = "force-dynamic";

export default async function SnapshotsPage() {
  const session = await getSessionUser();
  const snapshots = await listSnapshots(session.id);

  const rows: SnapshotRow[] = snapshots.map((s) => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt.toISOString(),
    payloadBytes: s.payloadBytes.toString(),
    schemaVersion: s.schemaVersion,
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Snapshots</h1>
        <p className="text-body text-muted-foreground">
          Save the current state of your transactional data — transactions, imports, ingestion
          history, classifications — so you can roll it back later. Useful before a reset or a mass
          email ingestion. Your accounts, categories, rules, budgets, and integrations are always
          kept and never affected by a restore.
        </p>
      </header>
      <SnapshotsManager snapshots={rows} />
    </main>
  );
}
