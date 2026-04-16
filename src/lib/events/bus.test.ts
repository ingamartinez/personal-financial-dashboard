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

    emit({ type: "transaction:created", id: 42, source: "sms", timestamp: 1 });

    expect(received).toEqual([
      { type: "transaction:created", id: 42, source: "sms", timestamp: 1 },
    ]);
  });

  it("delivers to multiple subscribers", () => {
    const a: AppEvent[] = [];
    const b: AppEvent[] = [];
    cleanups.push(subscribe((e) => a.push(e)));
    cleanups.push(subscribe((e) => b.push(e)));

    emit({ type: "budget:updated", timestamp: 2 });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", () => {
    const received: AppEvent[] = [];
    const off = subscribe((e) => received.push(e));

    emit({ type: "transaction:created", id: 1, source: "manual", timestamp: 3 });
    off();
    emit({ type: "transaction:created", id: 2, source: "manual", timestamp: 4 });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 1 });
  });
});
