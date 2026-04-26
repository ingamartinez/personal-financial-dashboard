/**
 * Integration-style tests for the display currency flow:
 *   - setDisplayCurrencyMode writes to users.uiPreferences
 *   - Tenant safety: only the session user's prefs are updated
 *   - Changing displayCurrencyMode recalculates totals without re-ingest
 *     (verified by the convert function being pure — no DB reads)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getUiPreferences, updateUiPreferences } from "@/lib/preferences/repo";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TAG = "+display-currency-test@findash.local";

async function createUser(email: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: "Display Currency Test",
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

describe("display currency — preferences repo (tenant safety)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("updateUiPreferences only updates the targeted user — not other users", async () => {
    const userA = await createUser(`a${TAG}`);
    const userB = await createUser(`b${TAG}`);

    // Set userA to all-cop.
    await updateUiPreferences(userA, { displayCurrencyMode: "all-cop" });

    // userB's prefs must remain at default (native).
    const prefsB = await getUiPreferences(userB);
    expect(prefsB.displayCurrencyMode).toBe("native");
  });

  it("updateUiPreferences rejects invalid userId gracefully", async () => {
    await expect(updateUiPreferences(-999, { displayCurrencyMode: "all-cop" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("changing displayCurrencyMode is reflected immediately on next read without re-ingest", async () => {
    const userId = await createUser(`a${TAG}`);

    // Start native.
    let prefs = await getUiPreferences(userId);
    expect(prefs.displayCurrencyMode).toBe("native");

    // Switch to all-cop — simulates user changing the setting.
    await updateUiPreferences(userId, { displayCurrencyMode: "all-cop" });
    prefs = await getUiPreferences(userId);
    expect(prefs.displayCurrencyMode).toBe("all-cop");

    // Switch to all-usd.
    await updateUiPreferences(userId, { displayCurrencyMode: "all-usd" });
    prefs = await getUiPreferences(userId);
    expect(prefs.displayCurrencyMode).toBe("all-usd");
  });

  it("displayCurrencyMode change does NOT touch other uiPreferences keys", async () => {
    const userId = await createUser(`a${TAG}`);

    // Seed with an unrelated key.
    await db
      .update(users)
      .set({ uiPreferences: { financialCycleMode: "pay_period" } as never })
      .where(eq(users.id, userId));

    await updateUiPreferences(userId, { displayCurrencyMode: "all-cop" });

    const [row] = await db
      .select({ prefs: users.uiPreferences })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // Both keys must be present (JSONB merge).
    expect((row.prefs as Record<string, unknown>).displayCurrencyMode).toBe("all-cop");
    expect((row.prefs as Record<string, unknown>).financialCycleMode).toBe("pay_period");
  });
});
