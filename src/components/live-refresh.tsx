"use client";

import { useLiveEvents } from "@/lib/hooks/use-live-events";

export function LiveRefresh() {
  useLiveEvents();
  return null;
}
