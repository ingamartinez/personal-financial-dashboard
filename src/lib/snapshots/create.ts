import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userSnapshots } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import {
  dumpUserPayload,
  estimatePayloadBytes,
  restoreUserPayload,
  validatePayloadShape,
  wipeUserData,
  type SnapshotPayload,
  type SnapshotTxn,
} from "./payload";
import { getCurrentSchemaVersion } from "./schema-version";

const log = createLogger({ module: "snapshots.core" });

export type CreatedSnapshot = {
  id: number;
  name: string;
  createdAt: Date;
  payloadBytes: bigint;
};

// Shared between the manual "Create snapshot" action (#471) and the
// auto-snapshot that the reset flow (#472) takes before wiping. Both need
// the same atomicity guarantees, so the work lives here and the "use server"
// wrappers just call into it.
export async function createSnapshotForUser(params: {
  userId: number;
  name: string;
  executor?: SnapshotTxn;
}): Promise<CreatedSnapshot> {
  const executor = params.executor ?? db;
  const payload = await dumpUserPayload(params.userId, executor);
  const schemaVersion = await getCurrentSchemaVersion();
  const payloadBytes = estimatePayloadBytes(payload);

  const [row] = await executor
    .insert(userSnapshots)
    .values({
      userId: params.userId,
      name: params.name,
      schemaVersion,
      payload: payload as unknown as object,
      payloadBytes,
    })
    .returning({
      id: userSnapshots.id,
      name: userSnapshots.name,
      createdAt: userSnapshots.createdAt,
      payloadBytes: userSnapshots.payloadBytes,
    });

  log.info(
    { userId: params.userId, snapshotId: row.id, bytes: Number(payloadBytes) },
    "snapshot created",
  );
  return row;
}

export type RestoreFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "schema_mismatch"; snapshotVersion: string; currentVersion: string };

export type RestoreSuccess = { ok: true };

export async function restoreSnapshotForUser(params: {
  userId: number;
  snapshotId: number;
}): Promise<RestoreSuccess | RestoreFailure> {
  const currentVersion = await getCurrentSchemaVersion();

  // Fetch + restore happen in one transaction so a concurrent delete of
  // the snapshot row can't leave the user half-wiped.
  return db.transaction<RestoreSuccess | RestoreFailure>(async (tx) => {
    const rows = await tx
      .select({
        id: userSnapshots.id,
        payload: userSnapshots.payload,
        schemaVersion: userSnapshots.schemaVersion,
      })
      .from(userSnapshots)
      .where(and(eq(userSnapshots.id, params.snapshotId), eq(userSnapshots.userId, params.userId)))
      .limit(1);

    const snapshot = rows[0];
    if (!snapshot) {
      return { ok: false, reason: "not_found" };
    }
    if (snapshot.schemaVersion !== currentVersion) {
      return {
        ok: false,
        reason: "schema_mismatch",
        snapshotVersion: snapshot.schemaVersion,
        currentVersion,
      };
    }

    validatePayloadShape(snapshot.payload);
    const payload = snapshot.payload as SnapshotPayload;

    await wipeUserData(params.userId, tx);
    await restoreUserPayload(params.userId, payload, tx);

    log.info({ userId: params.userId, snapshotId: params.snapshotId }, "snapshot restored");
    return { ok: true };
  });
}

export async function deleteSnapshotForUser(params: {
  userId: number;
  snapshotId: number;
}): Promise<boolean> {
  const result = await db
    .delete(userSnapshots)
    .where(and(eq(userSnapshots.id, params.snapshotId), eq(userSnapshots.userId, params.userId)))
    .returning({ id: userSnapshots.id });
  const deleted = result.length > 0;
  if (deleted) {
    log.info({ userId: params.userId, snapshotId: params.snapshotId }, "snapshot deleted");
  }
  return deleted;
}
