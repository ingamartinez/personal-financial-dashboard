import { db } from "@/lib/db";
import { userSnapshots } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { createSnapshotForUser } from "@/lib/snapshots/create";
import { wipeUserData } from "@/lib/snapshots/payload";

const log = createLogger({ module: "reset" });

export type ResetResult = {
  snapshot: {
    id: number;
    name: string;
    payloadBytes: bigint;
  };
};

// Wipes the user's transactional data (transactions, imports, ingestion
// history, observability, all children of those) and nulls the Gmail pull
// cursor so they can re-ingest the same messages. OAuth tokens, categories,
// rules, budgets, accounts — all config — stay untouched.
//
// Takes an auto-snapshot BEFORE the wipe, inside the same transaction, so
// a failed reset leaves nothing changed AND a succeeded reset always has
// a restore point. Snapshot name: `pre-reset-YYYY-MM-DD-HHmm`.
//
// The auto-snapshot row itself is in `user_snapshots`, which is NOT a
// snapshot table — it survives the wipe (by design — wipeUserData only
// touches entries in WIPE_ORDER).
export async function resetUserData(params: { userId: number }): Promise<ResetResult> {
  const name = buildPreResetName(new Date());

  return db.transaction<ResetResult>(async (tx) => {
    // Snapshot first so a wipe failure doesn't leave a dangling half-state
    // — if anything later throws, the whole tx rolls back and nothing
    // happened. If it all commits, the user has both the snapshot and the
    // empty ledger.
    const snapshot = await createSnapshotForUser({
      userId: params.userId,
      name,
      executor: tx,
    });

    await wipeUserData(params.userId, tx);

    log.info({ userId: params.userId, snapshotId: snapshot.id, name }, "user data reset");
    return { snapshot };
  });
}

// Exported for tests — otherwise the snapshot name includes the current
// time and is awkward to assert against.
export function buildPreResetName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  return `pre-reset-${yyyy}-${mm}-${dd}-${hh}${mi}`;
}

// Re-export the schema reference so tests that want to inspect
// `user_snapshots` can do so without reaching into `/lib/db/schema`
// (keeps the reset module's public surface small).
export { userSnapshots };
