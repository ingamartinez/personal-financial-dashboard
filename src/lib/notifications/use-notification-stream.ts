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
 * The optional `onOpen` callback fires each time the SSE connection opens
 * (including reconnects). Use it to close the SSR→SSE race window by
 * re-fetching server state after the stream is live.
 *
 * This hook coexists with useLiveEvents — both point at /api/events/stream/me
 * but serve different consumers. useLiveEvents drives router.refresh(); this
 * hook drives notification UI (Phase 3+).
 */
export function useNotificationStream(
  handler: (event: AppEvent) => void,
  options?: { onOpen?: () => void },
): void {
  // Stable refs so the effect doesn't re-run when the caller re-renders with
  // inline arrow functions. Refs are updated on every render (inside a layout
  // effect would also work, but plain useEffect is sufficient here since we
  // never read the ref during the same render we wrote it).
  const handlerRef = useRef(handler);
  const onOpenRef = useRef(options?.onOpen);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    onOpenRef.current = options?.onOpen;
  });

  useEffect(() => {
    const stream = createEventStream({
      url: STREAM_URL,
      onEvent: (event) => handlerRef.current(event),
      onOpen: () => onOpenRef.current?.(),
    });

    return () => {
      stream.close();
    };
  }, []); // mount/unmount only — URL is stable
}
