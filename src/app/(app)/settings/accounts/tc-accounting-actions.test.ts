import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isTcAccountingEnabled } from "@/lib/flags/tc-accounting";

const { getSessionUser } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser }));

const { setTcAccountingEnabled } = await import("./tc-accounting-actions");

const TAG = "+tc-accounting-action@findash.local";

async function createTestUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}${TAG}`,
      name: "TC accounting action test",
      role: "user",
      active: true,
      googleSub: `sub-${crypto.randomUUID()}`,
      featureFlags: {},
    })
    .returning({ id: users.id });
  return row.id;
}

async function cleanup() {
  const rows = await db.select({ id: users.id, email: users.email }).from(users);
  const ids = rows.filter((r) => r.email.endsWith(TAG)).map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(users).where(inArray(users.id, ids));
}

describe("setTcAccountingEnabled", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("persists the per-user override and is readable by the resolver", async () => {
    const id = await createTestUser();
    getSessionUser.mockResolvedValue({ id, email: "t@test.local", name: "T" });

    expect(await isTcAccountingEnabled(id)).toBe(false);

    await setTcAccountingEnabled(true);
    expect(await isTcAccountingEnabled(id)).toBe(true);

    await setTcAccountingEnabled(false);
    expect(await isTcAccountingEnabled(id)).toBe(false);
  });
});
