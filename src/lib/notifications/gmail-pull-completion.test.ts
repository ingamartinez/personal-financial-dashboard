import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@/lib/events/bus";
import { registerGmailPullCompletionEmitter } from "./gmail-pull-completion";

// ---------------------------------------------------------------------------
// emitNotification mock — hoisted so factories run before module-level code
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 999 }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

// ---------------------------------------------------------------------------
// Flush helper — await microtask queue so async bus subscribers settle
// ---------------------------------------------------------------------------
async function flush(): Promise<void> {
  // Two rounds ensure both the immediate microtask and any awaited-within-
  // subscribers work is settled without hitting real I/O.
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerGmailPullCompletionEmitter", () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    mocks.emitNotification.mockClear();
    mocks.emitNotification.mockResolvedValue({ id: 999 });
    unsubscribe = registerGmailPullCompletionEmitter();
  });

  afterEach(() => {
    unsubscribe();
  });

  it("emits notification when job:done fires for gmail-pull with newTxCount > 0", async () => {
    emit({
      type: "job:done",
      jobName: "gmail-pull",
      jobId: "job-abc-123",
      userId: 1,
      newTxCount: 5,
      processedCount: 12,
      timestamp: Date.now(),
    });
    await flush();

    expect(mocks.emitNotification).toHaveBeenCalledOnce();

    const [calledUserId, calledInput] = mocks.emitNotification.mock.calls[0]! as [
      number,
      {
        type: string;
        entityId: string;
        priority: string;
        title: string;
        body: string;
        actionUrl: string;
        metadata: { newTxCount: number; processedCount: number; jobId: string };
      },
    ];

    expect(calledUserId).toBe(1);
    expect(calledInput.type).toBe("gmail_pull_completed");
    expect(calledInput.entityId).toBe("job-abc-123");
    expect(calledInput.priority).toBe("low");
    expect(calledInput.title).toBe("Sincronización Gmail completada");
    expect(calledInput.body).toBe("Encontramos 5 movimiento(s) nuevos.");
    expect(calledInput.actionUrl).toBe("/transactions");
    expect(calledInput.metadata.newTxCount).toBe(5);
    expect(calledInput.metadata.processedCount).toBe(12);
    expect(calledInput.metadata.jobId).toBe("job-abc-123");
  });

  it("emits notification with 'no new transactions' body when newTxCount === 0", async () => {
    emit({
      type: "job:done",
      jobName: "gmail-pull",
      jobId: "job-def-456",
      userId: 2,
      newTxCount: 0,
      processedCount: 8,
      timestamp: Date.now(),
    });
    await flush();

    expect(mocks.emitNotification).toHaveBeenCalledOnce();

    const [, calledInput] = mocks.emitNotification.mock.calls[0]! as [
      number,
      { body: string; metadata: { newTxCount: number } },
    ];

    expect(calledInput.body).toBe("No encontramos movimientos nuevos.");
    expect(calledInput.metadata.newTxCount).toBe(0);
  });

  it("does NOT emit for job:done with jobName classify-tx", async () => {
    emit({
      type: "job:done",
      jobName: "classify-tx",
      jobId: "job-classify-789",
      userId: 1,
      classifiedCount: 10,
      skippedCount: 2,
      timestamp: Date.now(),
    });
    await flush();

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT emit for job:progress events", async () => {
    emit({
      type: "job:progress",
      jobName: "gmail-pull",
      jobId: "job-progress-111",
      userId: 1,
      phase: "pulling",
      timestamp: Date.now(),
    });
    await flush();

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("stops emitting after the returned unsubscribe fn is called", async () => {
    // Unsubscribe immediately (before any event).
    unsubscribe();

    emit({
      type: "job:done",
      jobName: "gmail-pull",
      jobId: "job-unsub-222",
      userId: 1,
      newTxCount: 3,
      processedCount: 3,
      timestamp: Date.now(),
    });
    await flush();

    expect(mocks.emitNotification).not.toHaveBeenCalled();

    // Prevent afterEach double-unsubscribe (safe but avoids noisy log).
    unsubscribe = () => undefined;
  });
});
