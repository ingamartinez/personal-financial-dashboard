import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { db, type DB } from "@/lib/db";
import type * as schemaModule from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import {
  GMAIL_CURSOR_COLUMNS,
  RESTORE_ORDER,
  SNAPSHOT_TABLES,
  WIPE_ORDER,
  type SnapshotTable,
} from "./tables";

const log = createLogger({ module: "snapshots.payload" });

// Drizzle's top-level `db` and the `tx` received inside `db.transaction` have
// structurally compatible query methods but nominally different types (one
// carries the schema generic, the other narrows it). Helpers accept either
// via this union so they can be composed inside or outside a transaction.
export type SnapshotTxn =
  | DB
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schemaModule,
      ExtractTablesWithRelations<typeof schemaModule>
    >;

// Shape of a serialized user snapshot. `version` exists to let future
// migrations of the payload format stay forward-compatible without breaking
// existing snapshots (we only support v1 right now).
export type SnapshotPayload = {
  version: 1;
  tables: Record<SnapshotTable, unknown[]>;
  gmailCursors: Array<{
    gmail_connection_id: number;
    last_pull_at: string | null;
    last_pull_history_id: string | null;
  }>;
};

// Postgres `jsonb_agg(row_to_json(t))` handles type conversion natively:
// bigints serialize to JSON numbers (or strings for out-of-range), timestamps
// to ISO strings, arrays stay arrays. `jsonb_populate_recordset` on the way
// back inflates into the target table, coercing types the same way. That's
// why we reach for raw SQL here rather than hand-rolling a per-column
// (de)serializer for each of the 14 snapshot tables.

export async function dumpUserPayload(
  userId: number,
  executor: SnapshotTxn = db,
): Promise<SnapshotPayload> {
  const tables: Record<string, unknown[]> = {};

  for (const table of SNAPSHOT_TABLES) {
    const rows = await executor.execute<{ rows: unknown[] | null }>(sql`
      SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) AS rows
      FROM ${sql.raw(table)} t
      WHERE t.user_id = ${userId}
    `);
    tables[table] = (rows[0]?.rows ?? []) as unknown[];
  }

  const cursorRows = await executor.execute<{
    gmail_connection_id: number;
    last_pull_at: string | null;
    last_pull_history_id: string | null;
  }>(sql`
    SELECT
      id AS gmail_connection_id,
      last_pull_at::text AS last_pull_at,
      last_pull_history_id
    FROM gmail_connections
    WHERE user_id = ${userId}
  `);

  return {
    version: 1,
    tables: tables as SnapshotPayload["tables"],
    gmailCursors: cursorRows.map((r) => ({
      gmail_connection_id: r.gmail_connection_id,
      last_pull_at: r.last_pull_at,
      last_pull_history_id: r.last_pull_history_id,
    })),
  };
}

// Hard-deletes every per-user row from the snapshot tables. The OAuth
// tokens, connection rows, and Gmail ingestion cursors are preserved so the
// user doesn't have to reauthorize and the next cron tick resumes from where
// it left off — NOT from a re-bootstrap window that would cause unintended
// mass re-ingestion (#498).
//
// MUST run inside a transaction — caller is responsible.
export async function wipeUserData(userId: number, tx: SnapshotTxn): Promise<void> {
  for (const table of WIPE_ORDER) {
    await tx.execute(sql`
      DELETE FROM ${sql.raw(table)} WHERE user_id = ${userId}
    `);
  }
  log.info({ userId, tables: WIPE_ORDER.length }, "wipe complete");
}

// Reinflates every snapshot table for the given user from the payload,
// preserving row IDs so FKs stay valid. Bumps the serial sequence of each
// table to max(id)+1 afterwards so future inserts don't collide. Restores
// Gmail cursor values onto matching connections.
//
// ASSUMES the user's transactional data has already been wiped — caller
// controls the order. Runs inside a transaction.
export async function restoreUserPayload(
  userId: number,
  payload: SnapshotPayload,
  tx: SnapshotTxn,
): Promise<void> {
  if (payload.version !== 1) {
    throw new Error(`snapshot.payload.unsupported_version: ${String(payload.version)}`);
  }

  for (const table of RESTORE_ORDER) {
    const rows = payload.tables[table] ?? [];
    if (rows.length === 0) continue;

    const jsonLiteral = JSON.stringify(rows);

    // jsonb_populate_recordset returns a set typed as the target table; we
    // splat it into INSERT. Tenant-safety: the WHERE clause on the source
    // payload already scoped to userId at dump time, but we double-check
    // here — a malformed payload with a foreign user_id would otherwise
    // break tenant isolation.
    await tx.execute(sql`
      INSERT INTO ${sql.raw(table)}
      SELECT * FROM jsonb_populate_recordset(NULL::${sql.raw(table)}, ${jsonLiteral}::jsonb) r
      WHERE r.user_id = ${userId}
    `);

    // Bump the id sequence past the highest restored id — otherwise the
    // next INSERT ... DEFAULT would clash. pg_get_serial_sequence returns
    // NULL for tables without a serial, but every snapshot table has one.
    await tx.execute(sql`
      SELECT setval(
        pg_get_serial_sequence(${table}, 'id'),
        GREATEST(
          (SELECT COALESCE(MAX(id), 0) FROM ${sql.raw(table)}),
          1
        )
      )
    `);
  }

  for (const cursor of payload.gmailCursors) {
    await tx.execute(sql`
      UPDATE gmail_connections
      SET last_pull_at = ${cursor.last_pull_at}::timestamptz,
          last_pull_history_id = ${cursor.last_pull_history_id},
          updated_at = NOW()
      WHERE id = ${cursor.gmail_connection_id} AND user_id = ${userId}
    `);
  }

  log.info(
    { userId, tables: RESTORE_ORDER.length, cursors: payload.gmailCursors.length },
    "restore complete",
  );
}

// Small, cheap metric the UI uses to show the user how big a snapshot is
// without having to parse the whole jsonb blob client-side.
export function estimatePayloadBytes(payload: SnapshotPayload): bigint {
  return BigInt(Buffer.byteLength(JSON.stringify(payload), "utf8"));
}

// Sanity guard: reject obviously bogus payloads before we try to restore.
// Anything deeper (per-column validation) is delegated to Postgres — if
// jsonb_populate_recordset can't coerce a value, it raises and we roll back.
export function validatePayloadShape(value: unknown): asserts value is SnapshotPayload {
  if (!value || typeof value !== "object") {
    throw new Error("snapshot.payload.invalid: not an object");
  }
  const p = value as Record<string, unknown>;
  if (p.version !== 1) {
    throw new Error(`snapshot.payload.invalid: unsupported version ${String(p.version)}`);
  }
  if (!p.tables || typeof p.tables !== "object") {
    throw new Error("snapshot.payload.invalid: missing tables");
  }
  const tables = p.tables as Record<string, unknown>;
  for (const table of SNAPSHOT_TABLES) {
    if (!Array.isArray(tables[table])) {
      throw new Error(`snapshot.payload.invalid: tables.${table} is not an array`);
    }
  }
  if (!Array.isArray(p.gmailCursors)) {
    throw new Error("snapshot.payload.invalid: gmailCursors is not an array");
  }
}

// Re-export for callers that want the type info without depending on tables.ts
export { GMAIL_CURSOR_COLUMNS, SNAPSHOT_TABLES };
