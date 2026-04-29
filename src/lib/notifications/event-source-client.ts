"use client";

import type { AppEvent } from "@/lib/events/bus";

export type EventStreamOptions = {
  url: string;
  onEvent: (event: AppEvent) => void;
  onError?: (err: Error) => void;
};

export type EventStreamHandle = {
  close: () => void;
};

// Exponential backoff caps: 1s → 2s → 4s → 8s → 16s → 30s.
const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Creates a persistent EventSource connection with automatic exponential
 * backoff reconnection. Resets the delay to 1 s after a successful event
 * is received (indicating a live connection).
 *
 * Pino is server-only; reconnect events are logged with console.error on the
 * client. The eslint-disable below is intentional — do not remove it.
 */
export function createEventStream(opts: EventStreamOptions): EventStreamHandle {
  const { url, onEvent, onError } = opts;

  let source: EventSource | null = null;
  let backoffIndex = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect() {
    if (closed) return;

    source = new EventSource(url);

    source.onmessage = (e: MessageEvent) => {
      // Reset backoff on a successful message — the connection is live.
      backoffIndex = 0;
      try {
        const event = JSON.parse(e.data as string) as AppEvent;
        onEvent(event);
      } catch {
        // malformed event — ignore
      }
    };

    source.onerror = () => {
      source?.close();
      source = null;

      if (closed) return;

      const delayMs = BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)];
      backoffIndex = Math.min(backoffIndex + 1, BACKOFF_STEPS_MS.length - 1);

      const err = new Error(`SSE connection lost; reconnecting in ${delayMs}ms`);
      if (onError) {
        onError(err);
      } else {
        // eslint-disable-next-line no-console
        console.error("[event-source-client] SSE connection lost; reconnecting", {
          url,
          delayMs,
        });
      }

      reconnectTimer = setTimeout(connect, delayMs);
    };
  }

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      source?.close();
      source = null;
    },
  };
}
