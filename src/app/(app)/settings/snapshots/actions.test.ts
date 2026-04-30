// Unit test for Wave 3 snapshot_restored emitter (#662).
// Spies on emitNotification and verifies it is called once with the correct
// shape after restoreSnapshotAction succeeds.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as emitModule from "@/lib/notifications/emit";

// ── module mocks ──────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const sessionMock = { id: 5, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

const { mockRestoreSnapshotForUser } = vi.hoisted(() => ({
  mockRestoreSnapshotForUser: vi.fn(),
}));

vi.mock("@/lib/snapshots/create", () => ({
  createSnapshotForUser: vi.fn(),
  deleteSnapshotForUser: vi.fn(),
  restoreSnapshotForUser: mockRestoreSnapshotForUser,
}));

// ── tests ─────────────────────────────────────────────────────────────────

describe("restoreSnapshotAction — snapshot_restored emitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRestoreSnapshotForUser.mockResolvedValue({ ok: true });
  });

  it("emits snapshot_restored once with correct shape when restore succeeds", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { restoreSnapshotAction } = await import("./actions");
    const result = await restoreSnapshotAction({ snapshotId: 12 });

    expect(result.status).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      sessionMock.id,
      expect.objectContaining({
        type: "snapshot_restored",
        entityId: "12",
        priority: "medium",
        title: "Snapshot restaurado",
        actionUrl: "/transactions",
      }),
    );
    expect(spy.mock.calls[0]![1].metadata).toMatchObject({ snapshotId: 12 });
  });

  it("does NOT emit when snapshot is not found", async () => {
    mockRestoreSnapshotForUser.mockResolvedValue({ ok: false, reason: "not_found" });
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { restoreSnapshotAction } = await import("./actions");
    const result = await restoreSnapshotAction({ snapshotId: 99 });

    expect(result.status).toBe("not_found");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT emit when restore throws", async () => {
    mockRestoreSnapshotForUser.mockRejectedValueOnce(new Error("db error"));
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { restoreSnapshotAction } = await import("./actions");
    const result = await restoreSnapshotAction({ snapshotId: 12 });

    expect(result.status).toBe("error");
    expect(spy).not.toHaveBeenCalled();
  });
});
