// Unit test for Wave 3 reset_complete emitter (#662).
// Spies on emitNotification and verifies it is called with the correct shape
// after resetUserData succeeds.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as emitModule from "@/lib/notifications/emit";

// ── module mocks ──────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const sessionMock = { id: 7, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

vi.mock("@/lib/reset/reset", () => ({
  resetUserData: vi.fn().mockResolvedValue({
    snapshot: { id: 1, name: "pre-reset-2026-04-30", payloadBytes: BigInt(1024) },
  }),
}));

// ── tests ─────────────────────────────────────────────────────────────────

describe("resetUserDataAction — reset_complete emitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits reset_complete once with correct shape when reset succeeds", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { resetUserDataAction } = await import("./actions");
    const result = await resetUserDataAction({ confirm: "RESET" });

    expect(result.status).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      sessionMock.id,
      expect.objectContaining({
        type: "reset_complete",
        priority: "medium",
        title: "Datos reseteados",
        actionUrl: "/transactions",
      }),
    );
    // entityId must follow the stable pattern "reset-{userId}-{YYYY-MM-DD}"
    const entityId = spy.mock.calls[0]![1].entityId;
    expect(entityId).toMatch(/^reset-7-\d{4}-\d{2}-\d{2}$/);
  });

  it("does NOT emit when confirmation text is wrong", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { resetUserDataAction } = await import("./actions");
    // @ts-expect-error — deliberate wrong literal to test validation
    const result = await resetUserDataAction({ confirm: "wrong" });

    expect(result.status).toBe("error");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT emit when resetUserData throws", async () => {
    const { resetUserData } = await import("@/lib/reset/reset");
    (resetUserData as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db error"));

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { resetUserDataAction } = await import("./actions");
    const result = await resetUserDataAction({ confirm: "RESET" });

    expect(result.status).toBe("error");
    expect(spy).not.toHaveBeenCalled();
  });
});
