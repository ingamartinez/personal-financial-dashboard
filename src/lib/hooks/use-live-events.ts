"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

type AppEventType =
  | "transaction:created"
  | "transaction:updated"
  | "budget:updated";

type WireEvent = { type: AppEventType };

const DEFAULT_REFRESH_ON: AppEventType[] = [
  "transaction:created",
  "transaction:updated",
  "budget:updated",
];

export function useLiveEvents(options?: {
  onEvent?: (type: AppEventType) => void;
  refreshOn?: AppEventType[];
}) {
  const router = useRouter();

  useEffect(() => {
    const refreshOn = options?.refreshOn ?? DEFAULT_REFRESH_ON;
    const source = new EventSource("/api/events/stream");

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WireEvent;
        options?.onEvent?.(event.type);
        if (refreshOn.includes(event.type)) {
          router.refresh();
        }
      } catch {
        // malformed — ignore
      }
    };

    return () => {
      source.close();
    };
  }, [options, router]);
}
