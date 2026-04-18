import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { countActiveAdmins, listAllUsers, setUserActive, setUserRole } from "./queries";

// These tests mutate the `users` table — they live in findash_test (forced by
// vitest.setup.ts). We tag test users with a distinct email suffix so cleanup
// only wipes rows we created, never the bootstrap admin (id=1) that other
// suites depend on.
const TAG = "+users-queries-test@findash.local";

async function createUser(opts: {
  email: string;
  name: string;
  role: "admin" | "user";
  active: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: opts.email,
      name: opts.name,
      role: opts.role,
      active: opts.active,
      googleSub: `sub-${opts.email}`,
    })
    .returning({ id: users.id });
  return row.id;
}

async function cleanup() {
  await db
    .delete(users)
    .where(
      inArray(users.email, [`admin-a${TAG}`, `admin-b${TAG}`, `regular${TAG}`, `inactive${TAG}`]),
    );
}

describe("users/queries", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("listAllUsers returns rows in id order with role + active fields", async () => {
    const aId = await createUser({
      email: `admin-a${TAG}`,
      name: "Admin A",
      role: "admin",
      active: true,
    });
    const rId = await createUser({
      email: `regular${TAG}`,
      name: "Regular",
      role: "user",
      active: true,
    });
    const all = await listAllUsers();
    const mine = all.filter((u) => u.id === aId || u.id === rId);
    expect(mine.map((u) => [u.role, u.active])).toEqual([
      ["admin", true],
      ["user", true],
    ]);
  });

  it("refuses to deactivate the last active admin", async () => {
    // Temporarily demote the bootstrap admin so our seeded admin-a is the
    // only active admin. Restore afterwards.
    await db.update(users).set({ role: "user" }).where(eq(users.id, 1));
    try {
      const aId = await createUser({
        email: `admin-a${TAG}`,
        name: "Admin A",
        role: "admin",
        active: true,
      });
      expect(await countActiveAdmins()).toBe(1);
      const result = await setUserActive({ userId: aId, active: false });
      expect(result).toBe("last-admin");
      expect(await countActiveAdmins()).toBe(1);
    } finally {
      await db.update(users).set({ role: "admin" }).where(eq(users.id, 1));
    }
  });

  it("allows deactivating an admin when another active admin exists", async () => {
    const aId = await createUser({
      email: `admin-a${TAG}`,
      name: "Admin A",
      role: "admin",
      active: true,
    });
    const bId = await createUser({
      email: `admin-b${TAG}`,
      name: "Admin B",
      role: "admin",
      active: true,
    });
    const result = await setUserActive({ userId: aId, active: false });
    expect(result).toBe("ok");
    const [after] = await db.select({ active: users.active }).from(users).where(eq(users.id, aId));
    expect(after.active).toBe(false);
    // Cleanup: also delete bId via cleanup() helper; nothing else to do.
    expect(bId).toBeGreaterThan(0);
  });

  it("refuses to demote the last active admin", async () => {
    await db.update(users).set({ role: "user" }).where(eq(users.id, 1));
    try {
      const aId = await createUser({
        email: `admin-a${TAG}`,
        name: "Admin A",
        role: "admin",
        active: true,
      });
      const result = await setUserRole({ userId: aId, role: "user" });
      expect(result).toBe("last-admin");
      const [after] = await db.select({ role: users.role }).from(users).where(eq(users.id, aId));
      expect(after.role).toBe("admin");
    } finally {
      await db.update(users).set({ role: "admin" }).where(eq(users.id, 1));
    }
  });

  it("allows demoting an admin when another active admin exists", async () => {
    const aId = await createUser({
      email: `admin-a${TAG}`,
      name: "Admin A",
      role: "admin",
      active: true,
    });
    await createUser({
      email: `admin-b${TAG}`,
      name: "Admin B",
      role: "admin",
      active: true,
    });
    const result = await setUserRole({ userId: aId, role: "user" });
    expect(result).toBe("ok");
    const [after] = await db.select({ role: users.role }).from(users).where(eq(users.id, aId));
    expect(after.role).toBe("user");
  });

  it("inactive admins don't count toward the last-admin guard (can deactivate them)", async () => {
    // An "inactive admin" should be treated as a non-participating admin for
    // the purposes of the invariant — their row doesn't protect anyone.
    const inactiveId = await createUser({
      email: `inactive${TAG}`,
      name: "Inactive Admin",
      role: "admin",
      active: false,
    });
    const result = await setUserActive({ userId: inactiveId, active: false });
    expect(result).toBe("ok");
  });

  it("promoting and reactivating are always allowed (no guard needed)", async () => {
    const rId = await createUser({
      email: `regular${TAG}`,
      name: "Regular",
      role: "user",
      active: true,
    });
    expect(await setUserRole({ userId: rId, role: "admin" })).toBe("ok");
    const inactiveId = await createUser({
      email: `inactive${TAG}`,
      name: "Inactive",
      role: "user",
      active: false,
    });
    expect(await setUserActive({ userId: inactiveId, active: true })).toBe("ok");
  });
});
