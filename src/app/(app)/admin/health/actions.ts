"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/session";
import { snapshotAllActiveUsers } from "@/lib/telemetry/user-health";

export type SnapshotNowResult =
  | { status: "ok"; users: number; churnFlagged: number; failed: number }
  | { status: "error"; message: string };

export async function runSnapshotNow(): Promise<SnapshotNowResult> {
  await requireAdmin();
  try {
    const results = await snapshotAllActiveUsers();
    const churnFlagged = results.filter((r) => r.ok && r.data.churnSignalFlag).length;
    const failed = results.filter((r) => !r.ok).length;
    revalidatePath("/admin/health");
    return { status: "ok", users: results.length, churnFlagged, failed };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
