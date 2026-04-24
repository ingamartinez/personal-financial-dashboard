import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// Drizzle tracks applied migrations in `drizzle.__drizzle_migrations`; the
// `hash` of the most recent row is a content-addressed fingerprint of the
// current schema. We pin snapshots to this hash at create time and refuse
// to restore across mismatches — reinflating a JSON dump into a table whose
// columns have shifted would silently corrupt data.
//
// Cross-migration restore is explicitly out of scope for MVP (#471). If you
// migrate the schema, snapshots from before the migration become read-only
// (user sees them but can't restore). That's fine for now.

export async function getCurrentSchemaVersion(): Promise<string> {
  const rows = await db.execute<{ hash: string }>(
    sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`,
  );
  const hash = rows[0]?.hash;
  if (!hash) {
    throw new Error("snapshot.schema_version.missing: drizzle.__drizzle_migrations is empty");
  }
  return hash;
}
