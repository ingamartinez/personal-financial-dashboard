"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tracks which IDs in the current list appeared since the previous render and
 * flags them as "new" for `ttlMs` milliseconds. Used to animate freshly-arrived
 * rows after a soft refresh (e.g. `router.refresh()` on SSE events).
 *
 * Implementation notes:
 * - State is intentionally derived from refs + time on each render. This is the
 *   simplest correct shape for "prop change since last render" without scheduling
 *   a rerender for the first mount, which would cause the initial rows to flash.
 * - The React purity / set-state-in-effect rules flag this file on purpose; the
 *   suppressions below are local and scoped.
 */
/* eslint-disable react-hooks/purity */
export function useNewIds<T extends string | number>(ids: readonly T[], ttlMs = 2500): Set<T> {
  const seenRef = useRef<Set<T> | null>(null);
  const expiryRef = useRef<Map<T, number>>(new Map());
  const [, force] = useState(0);

  if (seenRef.current === null) {
    seenRef.current = new Set(ids);
  }

  const now = Date.now();
  const seen = seenRef.current;
  const expiries = expiryRef.current;

  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      expiries.set(id, now + ttlMs);
    }
  }

  const current = new Set<T>();
  for (const [id, expiry] of expiries) {
    if (expiry > now) {
      current.add(id);
    } else {
      expiries.delete(id);
    }
  }

  useEffect(() => {
    if (expiries.size === 0) return;
    let nearest = Infinity;
    const t = Date.now();
    for (const expiry of expiries.values()) {
      if (expiry > t && expiry < nearest) nearest = expiry;
    }
    if (nearest === Infinity) return;
    const delay = Math.max(0, nearest - t) + 10;
    const handle = setTimeout(() => {
      force((x) => x + 1);
    }, delay);
    return () => clearTimeout(handle);
  });

  return current;
}
