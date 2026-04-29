import { EventEmitter } from "node:events";
import type { TransactionSource } from "@/lib/types";

export type NotificationPayload = {
  title: string;
  body: string;
  actionUrl?: string;
  priority: "high" | "medium" | "low";
  type: string;
  metadata?: Record<string, unknown>;
};

export type AppEvent =
  | {
      type: "transaction:created";
      userId: number;
      id: number;
      source: TransactionSource;
      timestamp: number;
    }
  | {
      type: "transaction:updated";
      userId: number;
      id: number;
      source: TransactionSource;
      timestamp: number;
    }
  | {
      type: "transaction:bulk-updated";
      userId: number;
      count: number;
      reason: "counterparty-updated" | "counterparty-created";
      timestamp: number;
    }
  | {
      type: "counterparty:updated";
      userId: number;
      id: number;
      reason: "edit" | "merge" | "split";
      timestamp: number;
    }
  | {
      type: "recurring-gap:resolved";
      userId: number;
      gapId: number | null;
      reason: "linked" | "synthetic" | "skipped" | "auto-linked";
      timestamp: number;
    }
  | { type: "budget:updated"; userId: number; timestamp: number }
  | {
      type: "notification:created";
      userId: number;
      audience: "user" | "admin";
      notificationId: number;
      payload: NotificationPayload;
    }
  | {
      type: "gmail:reconnected";
      userId: number;
      connectionId: number;
      timestamp: number;
    }
  | {
      type: "slo:resolved";
      userId: number;
      alertId: number;
      timestamp: number;
    };

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
