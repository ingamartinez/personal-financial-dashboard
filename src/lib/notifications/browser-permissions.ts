export type BrowserNotificationPermission = "default" | "granted" | "denied" | "unsupported";

/**
 * Returns the current browser notification permission state without side effects.
 * Returns "unsupported" when the Notification API is unavailable (SSR, iOS Safari
 * without home-screen PWA, etc.).
 */
export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as BrowserNotificationPermission;
}

/**
 * Requests browser notification permission lazily (only when permission is
 * "default"). Returns the resulting permission state.
 *
 * Safe to call on iOS Safari — if `Notification` is not in window, returns
 * "unsupported" without throwing.
 */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") {
    return Notification.permission as BrowserNotificationPermission;
  }
  const result = await Notification.requestPermission();
  return result as BrowserNotificationPermission;
}
