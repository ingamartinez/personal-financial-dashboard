"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { AppEvent } from "@/lib/events/bus";

const DEFAULT_REFRESH_ON: AppEvent["type"][] = [
  "transaction:created",
  "transaction:updated",
  "transaction:bulk-updated",
  "counterparty:updated",
  "recurring-gap:resolved",
  "budget:updated",
];

export function useLiveEvents(options?: {
  onEvent?: (event: AppEvent) => void;
  refreshOn?: AppEvent["type"][];
}) {
  const router = useRouter();

  useEffect(() => {
    const refreshOn = options?.refreshOn ?? DEFAULT_REFRESH_ON;
    const source = new EventSource("/api/events/stream");

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AppEvent;
        options?.onEvent?.(event);
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
