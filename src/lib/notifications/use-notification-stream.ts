"use client";

import { useEffect, useRef } from "react";
import type { AppEvent } from "@/lib/events/bus";
import { createEventStream } from "./event-source-client";

const STREAM_URL = "/api/events/stream/me";

/**
 * Mounts a persistent SSE connection to /api/events/stream/me on mount and
 * closes it on unmount. Reconnects automatically with exponential backoff.
 *
 * The `handler` receives the full AppEvent discriminated union. Narrow by
 * type in the caller:
 *
 *   useNotificationStream((event) => {
 *     if (event.type === "notification:created") { ... }
 *   });
 *
 * This hook coexists with useLiveEvents — both point at /api/events/stream/me
 * but serve different consumers. useLiveEvents drives router.refresh(); this
 * hook drives notification UI (Phase 3+).
 */
export function useNotificationStream(handler: (event: AppEvent) => void): void {
  // Stable ref so the effect doesn't re-run when the caller re-renders with
  // an inline arrow function passed as handler. The ref is updated inside an
  // effect (not during render) to satisfy react-hooks/refs.
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const stream = createEventStream({
      url: STREAM_URL,
      onEvent: (event) => handlerRef.current(event),
    });

    return () => {
      stream.close();
    };
  }, []); // mount/unmount only — URL is stable
}
