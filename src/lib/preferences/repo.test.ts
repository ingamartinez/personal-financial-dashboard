import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getUiPreferences, updateUiPreferences } from "./repo";

// Tests mutate the `users` table — they run against findash_test (forced by
// vitest.setup.ts). Emails are tagged so cleanup only wipes rows we created.
const TAG = "+preferences-repo-test@findash.local";

async function createUser(email: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: "Prefs Test",
      role: "user",
      active: true,
      googleSub: `sub-${email}`,
    })
    .returning({ id: users.id });
  return row.id;
}

async function cleanup() {
  await db.delete(users).where(inArray(users.email, [`a${TAG}`, `b${TAG}`]));
}

describe("preferences/repo", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("getUiPreferences returns default displayCurrencyMode when pref is empty", async () => {
    const userId = await createUser(`a${TAG}`);
    const prefs = await getUiPreferences(userId);
    expect(prefs.displayCurrencyMode).toBe("native");
  });

  it("updateUiPreferences persists and returns the new value", async () => {
    const userId = await createUser(`a${TAG}`);
    const updated = await updateUiPreferences(userId, { displayCurrencyMode: "all-cop" });
    expect(updated.displayCurrencyMode).toBe("all-cop");
    const read = await getUiPreferences(userId);
    expect(read.displayCurrencyMode).toBe("all-cop");
  });

  it("updateUiPreferences merges at the JSONB level (preserves unrelated keys)", async () => {
    const userId = await createUser(`a${TAG}`);
    // Plant an unrelated key directly so we can prove the merge doesn't drop it.
    await db
      .update(users)
      .set({ uiPreferences: { displayCurrencyMode: "all-usd", futureKey: "keep-me" } as never })
      .where(eq(users.id, userId));
    await updateUiPreferences(userId, { displayCurrencyMode: "native" });
    const [row] = await db
      .select({ prefs: users.uiPreferences })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(row.prefs).toEqual({ displayCurrencyMode: "native", futureKey: "keep-me" });
  });

  it("getUiPreferences falls back to default for an unknown mode value", async () => {
    const userId = await createUser(`a${TAG}`);
    await db
      .update(users)
      .set({ uiPreferences: { displayCurrencyMode: "bogus-mode" } as never })
      .where(eq(users.id, userId));
    const prefs = await getUiPreferences(userId);
    expect(prefs.displayCurrencyMode).toBe("native");
  });

  it("updateUiPreferences throws for a missing user", async () => {
    await expect(updateUiPreferences(-999, { displayCurrencyMode: "all-cop" })).rejects.toThrow(
      /not found/i,
    );
  });
});
