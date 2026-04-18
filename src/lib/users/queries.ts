import { and, eq, ne, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { users } from "@/lib/db/schema";

export type UserRole = "admin" | "user";

export type UserRow = {
  id: number;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: UserRole;
  active: boolean;
  createdAt: Date;
};

function toUserRow(r: {
  id: number;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: string;
  active: boolean;
  createdAt: Date;
}): UserRow {
  return { ...r, role: r.role === "admin" ? "admin" : "user" };
}

export async function listAllUsers(db: DB = defaultDb): Promise<UserRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      pictureUrl: users.pictureUrl,
      role: users.role,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.id);
  return rows.map(toUserRow);
}

/**
 * Counts currently-active admins. Used to enforce the last-admin invariant
 * before deactivating or demoting a user.
 */
export async function countActiveAdmins(db: DB = defaultDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true)));
  return row?.n ?? 0;
}

/**
 * Atomic last-admin guard. Applies the patch only if doing so preserves at
 * least one other active admin besides `targetUserId`. Returns `true` if
 * the update happened, `false` if the guard blocked it.
 */
async function updateIfNotLastAdmin(opts: {
  db: DB;
  targetUserId: number;
  patch: Partial<{ role: UserRole; active: boolean }>;
}): Promise<boolean> {
  const { db, targetUserId, patch } = opts;
  const result = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(users.id, targetUserId),
        sql`EXISTS (SELECT 1 FROM users u2 WHERE u2.id <> ${targetUserId} AND u2.role = 'admin' AND u2.active = true)`,
      ),
    )
    .returning({ id: users.id });
  return result.length > 0;
}

export type UpdateResult = "ok" | "last-admin";

export async function setUserActive(opts: {
  userId: number;
  active: boolean;
  db?: DB;
}): Promise<UpdateResult> {
  const db = opts.db ?? defaultDb;
  if (opts.active) {
    // Reactivating is always safe — no admin-count concern.
    await db
      .update(users)
      .set({ active: true, updatedAt: new Date() })
      .where(eq(users.id, opts.userId));
    return "ok";
  }
  // Deactivating: block if target is the last active admin.
  const [target] = await db
    .select({ role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, opts.userId))
    .limit(1);
  if (!target) return "ok";
  if (target.role !== "admin" || !target.active) {
    await db
      .update(users)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(users.id, opts.userId));
    return "ok";
  }
  const ok = await updateIfNotLastAdmin({
    db,
    targetUserId: opts.userId,
    patch: { active: false },
  });
  return ok ? "ok" : "last-admin";
}

export async function setUserRole(opts: {
  userId: number;
  role: UserRole;
  db?: DB;
}): Promise<UpdateResult> {
  const db = opts.db ?? defaultDb;
  if (opts.role === "admin") {
    // Promoting is always safe.
    await db
      .update(users)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(users.id, opts.userId));
    return "ok";
  }
  // Demoting: block if target is the last active admin.
  const [target] = await db
    .select({ role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, opts.userId))
    .limit(1);
  if (!target) return "ok";
  if (target.role !== "admin" || !target.active) {
    await db
      .update(users)
      .set({ role: "user", updatedAt: new Date() })
      .where(and(eq(users.id, opts.userId), ne(users.role, "user")));
    return "ok";
  }
  const ok = await updateIfNotLastAdmin({
    db,
    targetUserId: opts.userId,
    patch: { role: "user" },
  });
  return ok ? "ok" : "last-admin";
}
