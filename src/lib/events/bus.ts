import { EventEmitter } from "node:events";

export type TransactionSource = "sms" | "manual";

export type AppEvent =
  | {
      type: "transaction:created";
      id: number;
      source: TransactionSource;
      timestamp: number;
    }
  | {
      type: "transaction:updated";
      id: number;
      source: TransactionSource;
      timestamp: number;
    }
  | {
      type: "transaction:bulk-updated";
      count: number;
      reason: "counterparty-updated" | "counterparty-created";
      timestamp: number;
    }
  | {
      type: "counterparty:updated";
      id: number;
      reason: "edit" | "merge" | "split";
      timestamp: number;
    }
  | { type: "budget:updated"; timestamp: number };

// globalThis singleton survives Turbopack HMR, which otherwise re-evaluates
// this module and would leave SSE subscribers attached to a stale bus.
declare global {
  var __findashEventBus: EventEmitter | undefined;
}

function getBus(): EventEmitter {
  if (!globalThis.__findashEventBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(50);
    globalThis.__findashEventBus = bus;
  }
  return globalThis.__findashEventBus;
}

export function emit(event: AppEvent): void {
  getBus().emit("event", event);
}

export function subscribe(listener: (event: AppEvent) => void): () => void {
  const bus = getBus();
  bus.on("event", listener);
  return () => {
    bus.off("event", listener);
  };
}
