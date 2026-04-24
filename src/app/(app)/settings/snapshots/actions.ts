"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";
import {
  createSnapshotForUser,
  deleteSnapshotForUser,
  restoreSnapshotForUser,
  type CreatedSnapshot,
} from "@/lib/snapshots/create";

const log = createLogger({ module: "snapshots.actions" });

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export type CreateSnapshotResult =
  | { status: "ok"; snapshot: { id: number; name: string; payloadBytes: string } }
  | { status: "error"; message: string };

export async function createSnapshotAction(
  input: z.input<typeof createSchema>,
): Promise<CreateSnapshotResult> {
  const session = await getSessionUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Invalid snapshot name." };
  }

  try {
    const row: CreatedSnapshot = await createSnapshotForUser({
      userId: session.id,
      name: parsed.data.name,
    });
    revalidatePath("/settings/snapshots");
    return {
      status: "ok",
      snapshot: {
        id: row.id,
        name: row.name,
        payloadBytes: row.payloadBytes.toString(),
      },
    };
  } catch (err) {
    log.error({ err, userId: session.id, event: "create_failed" }, "create snapshot failed");
    return { status: "error", message: "Failed to create snapshot." };
  }
}

const idSchema = z.object({
  snapshotId: z.coerce.number().int().positive(),
});

export type RestoreSnapshotResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "schema_mismatch"; snapshotVersion: string; currentVersion: string }
  | { status: "error"; message: string };

export async function restoreSnapshotAction(
  input: z.input<typeof idSchema>,
): Promise<RestoreSnapshotResult> {
  const session = await getSessionUser();
  const { snapshotId } = idSchema.parse(input);

  try {
    const result = await restoreSnapshotForUser({ userId: session.id, snapshotId });
    if (!result.ok) {
      if (result.reason === "not_found") {
        return { status: "not_found" };
      }
      return {
        status: "schema_mismatch",
        snapshotVersion: result.snapshotVersion,
        currentVersion: result.currentVersion,
      };
    }
    revalidatePath("/settings/snapshots");
    revalidatePath("/");
    revalidatePath("/transactions");
    return { status: "ok" };
  } catch (err) {
    log.error(
      { err, userId: session.id, snapshotId, event: "restore_failed" },
      "restore snapshot failed",
    );
    return { status: "error", message: "Failed to restore snapshot." };
  }
}

export async function deleteSnapshotAction(
  input: z.input<typeof idSchema>,
): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  const session = await getSessionUser();
  const { snapshotId } = idSchema.parse(input);

  try {
    const deleted = await deleteSnapshotForUser({ userId: session.id, snapshotId });
    revalidatePath("/settings/snapshots");
    return deleted ? { status: "ok" } : { status: "error", message: "Snapshot not found." };
  } catch (err) {
    log.error(
      { err, userId: session.id, snapshotId, event: "delete_failed" },
      "delete snapshot failed",
    );
    return { status: "error", message: "Failed to delete snapshot." };
  }
}
