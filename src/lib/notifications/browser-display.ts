import type { NotificationPriority } from "./emit";

export interface DisplayNotificationInput {
  title: string;
  body: string;
  /** Used as OS-level tag for dedup/replace — same entityId replaces prior banner. */
  tag: string;
  priority: NotificationPriority;
  actionUrl?: string;
}

/**
 * Show a browser-native notification when ALL of the following hold:
 *  - The Notification API is supported and permission is "granted"
 *  - The document is hidden (avoids double-firing when the tab is in focus)
 *  - The priority is "high" (low/medium stay in the bell dropdown)
 *
 * The `navigate` callback is called with `actionUrl` when the user clicks the
 * banner. Pass `router.push` from `next/navigation`.
 *
 * Returns the Notification instance for click/close wiring, or null if skipped.
 */
export function maybeShowBrowserNotification(
  input: DisplayNotificationInput,
  navigate: (url: string) => void,
): Notification | null {
  if (typeof window === "undefined") return null;
  if (!("Notification" in window)) return null;
  if (Notification.permission !== "granted") return null;
  if (!document.hidden) return null;
  if (input.priority !== "high") return null;

  const n = new Notification(input.title, {
    body: input.body,
    tag: input.tag,
  });

  n.onclick = () => {
    window.focus();
    if (input.actionUrl) navigate(input.actionUrl);
    n.close();
  };

  return n;
}
