import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { isTcAccountingEnabled, writeTcAccountingEnabled } from "./tc-accounting";

const TAG = "+tc-accounting-flag@findash.local";

async function createTestUser(flag: boolean | undefined): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}${TAG}`,
      name: "TC accounting flag test",
      role: "user",
      active: true,
      googleSub: `sub-${crypto.randomUUID()}`,
      featureFlags: flag === undefined ? {} : { tcAccountingEnabled: flag },
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

describe("isTcAccountingEnabled", () => {
  const originalEnv = process.env.TC_ACCOUNTING_ENABLED;

  beforeEach(cleanup);
  afterEach(async () => {
    await cleanup();
    if (originalEnv === undefined) delete process.env.TC_ACCOUNTING_ENABLED;
    else process.env.TC_ACCOUNTING_ENABLED = originalEnv;
  });

  it("defers to env var when user has no flag set", async () => {
    const id = await createTestUser(undefined);

    process.env.TC_ACCOUNTING_ENABLED = "true";
    expect(await isTcAccountingEnabled(id)).toBe(true);

    process.env.TC_ACCOUNTING_ENABLED = "false";
    expect(await isTcAccountingEnabled(id)).toBe(false);

    delete process.env.TC_ACCOUNTING_ENABLED;
    expect(await isTcAccountingEnabled(id)).toBe(false);
  });

  it("defaults to off when neither per-user flag nor env is set", async () => {
    const id = await createTestUser(undefined);
    delete process.env.TC_ACCOUNTING_ENABLED;
    expect(await isTcAccountingEnabled(id)).toBe(false);
  });

  it("per-user flag=true overrides env var=false", async () => {
    const id = await createTestUser(true);
    process.env.TC_ACCOUNTING_ENABLED = "false";
    expect(await isTcAccountingEnabled(id)).toBe(true);
  });

  it("per-user flag=false overrides env var=true", async () => {
    const id = await createTestUser(false);
    process.env.TC_ACCOUNTING_ENABLED = "true";
    expect(await isTcAccountingEnabled(id)).toBe(false);
  });

  it("writeTcAccountingEnabled persists an explicit override", async () => {
    const id = await createTestUser(undefined);
    delete process.env.TC_ACCOUNTING_ENABLED;
    expect(await isTcAccountingEnabled(id)).toBe(false);

    await writeTcAccountingEnabled(id, true);
    expect(await isTcAccountingEnabled(id)).toBe(true);

    await writeTcAccountingEnabled(id, false);
    process.env.TC_ACCOUNTING_ENABLED = "true";
    expect(await isTcAccountingEnabled(id)).toBe(false);
  });
});
