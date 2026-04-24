import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userSnapshots } from "@/lib/db/schema";

// Read-only views for server components. Tenant isolation is enforced by
// every query scoping to `userId`; callers upstream are responsible for
// passing the authenticated user — never trust client-supplied ids.

export type SnapshotSummary = {
  id: number;
  name: string;
  createdAt: Date;
  payloadBytes: bigint;
  schemaVersion: string;
};

export async function listSnapshots(userId: number): Promise<SnapshotSummary[]> {
  const rows = await db
    .select({
      id: userSnapshots.id,
      name: userSnapshots.name,
      createdAt: userSnapshots.createdAt,
      payloadBytes: userSnapshots.payloadBytes,
      schemaVersion: userSnapshots.schemaVersion,
    })
    .from(userSnapshots)
    .where(eq(userSnapshots.userId, userId))
    .orderBy(desc(userSnapshots.createdAt));
  return rows;
}

export async function getSnapshotSummary(
  userId: number,
  snapshotId: number,
): Promise<SnapshotSummary | null> {
  const rows = await db
    .select({
      id: userSnapshots.id,
      name: userSnapshots.name,
      createdAt: userSnapshots.createdAt,
      payloadBytes: userSnapshots.payloadBytes,
      schemaVersion: userSnapshots.schemaVersion,
    })
    .from(userSnapshots)
    .where(and(eq(userSnapshots.id, snapshotId), eq(userSnapshots.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}
