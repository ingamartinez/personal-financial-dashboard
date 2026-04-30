import { afterEach, describe, expect, it } from "vitest";
import { emit, subscribe, type AppEvent } from "./bus";

describe("event bus", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("delivers an event to a subscriber", () => {
    const received: AppEvent[] = [];
    cleanups.push(subscribe((e) => received.push(e)));

    emit({
      type: "transaction:created",
      userId: 1,
      id: 42,
      source: "sms",
      timestamp: 1,
    });

    expect(received).toEqual([
      { type: "transaction:created", userId: 1, id: 42, source: "sms", timestamp: 1 },
    ]);
  });

  it("delivers to multiple subscribers", () => {
    const a: AppEvent[] = [];
    const b: AppEvent[] = [];
    cleanups.push(subscribe((e) => a.push(e)));
    cleanups.push(subscribe((e) => b.push(e)));

    emit({ type: "budget:updated", userId: 1, timestamp: 2 });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", () => {
    const received: AppEvent[] = [];
    const off = subscribe((e) => received.push(e));

    emit({ type: "transaction:created", userId: 1, id: 1, source: "manual", timestamp: 3 });
    off();
    emit({ type: "transaction:created", userId: 1, id: 2, source: "manual", timestamp: 4 });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 1 });
  });

  it("delivers notification:created event to subscriber", () => {
    const received: AppEvent[] = [];
    cleanups.push(subscribe((e) => received.push(e)));

    emit({
      type: "notification:created",
      userId: 5,
      audience: "user",
      notificationId: 99,
      payload: {
        title: "New transaction",
        body: "A payment of $10 was received",
        priority: "high",
        type: "transaction_alert",
      },
    });

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.type).toBe("notification:created");
    if (event.type === "notification:created") {
      expect(event.userId).toBe(5);
      expect(event.audience).toBe("user");
      expect(event.notificationId).toBe(99);
      expect(event.payload.title).toBe("New transaction");
      expect(event.payload.priority).toBe("high");
    }
  });

  it("delivers disambiguation:resolved event to subscriber", () => {
    const received: AppEvent[] = [];
    cleanups.push(subscribe((e) => received.push(e)));

    emit({
      type: "disambiguation:resolved",
      userId: 7,
      receiptId: 42,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.type).toBe("disambiguation:resolved");
    if (event.type === "disambiguation:resolved") {
      expect(event.userId).toBe(7);
      expect(event.receiptId).toBe(42);
    }
  });
});
