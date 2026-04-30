// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoisted shared state — vi.mock factories are hoisted above top-level consts,
// so we share mocks via vi.hoisted.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const listNotifications = vi.fn<() => Promise<{ items: unknown[]; nextCursor: null }>>();
  const markAsRead = vi.fn<() => Promise<{ ok: boolean }>>();
  const markAllAsRead = vi.fn<() => Promise<{ count: number }>>();
  const unreadCount = vi.fn<() => Promise<{ count: number }>>();
  const toastFn = vi.fn();
  const toastError = vi.fn();

  return { listNotifications, markAsRead, markAllAsRead, unreadCount, toastFn, toastError };
});

// ---------------------------------------------------------------------------
// Mock server actions
// ---------------------------------------------------------------------------
vi.mock("@/app/(app)/notifications/actions", () => ({
  listNotifications: mocks.listNotifications,
  markAsRead: mocks.markAsRead,
  markAllAsRead: mocks.markAllAsRead,
  unreadCount: mocks.unreadCount,
}));

// ---------------------------------------------------------------------------
// Mock sonner
// ---------------------------------------------------------------------------
vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toastFn, {
    error: mocks.toastError,
  }),
}));

// ---------------------------------------------------------------------------
// Mock useNotificationStream — expose handles to fire SSE events and onOpen
// ---------------------------------------------------------------------------
type StreamHandler = (event: unknown) => void;
type StreamOptions = { onOpen?: () => void };

let capturedHandler: StreamHandler = () => {};
let capturedOnOpen: (() => void) | undefined;

vi.mock("@/lib/notifications/use-notification-stream", () => ({
  useNotificationStream: (handler: StreamHandler, options?: StreamOptions) => {
    capturedHandler = handler;
    capturedOnOpen = options?.onOpen;
  },
}));

// Import AFTER mocks.
import { BellButton } from "./bell-button";

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------
function makeNotification(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "system",
    entityId: null,
    audience: "user",
    title: `Notification ${id}`,
    body: `Body of notification ${id}`,
    actionUrl: null,
    priority: "medium",
    metadata: {},
    readAt: null,
    createdAt: new Date("2026-04-29T10:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers — both desktop and mobile triggers render; pick the desktop one.
// In jsdom there's no CSS visibility, so both are present in the DOM.
// We query getAllBy* and take index 0 (desktop DropdownMenu trigger).
// ---------------------------------------------------------------------------
function getDesktopBellButton() {
  const buttons = screen.getAllByRole("button", { name: /notificaciones/i });
  return buttons[0]; // desktop DropdownMenuTrigger
}

// ---------------------------------------------------------------------------
// Radix shims + reset
// ---------------------------------------------------------------------------
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  // Default: resolve with an empty list.
  mocks.listNotifications.mockResolvedValue({ items: [], nextCursor: null });
  mocks.markAsRead.mockResolvedValue({ ok: true });
  mocks.markAllAsRead.mockResolvedValue({ count: 0 });
  mocks.unreadCount.mockResolvedValue({ count: 0 });

  capturedHandler = () => {};
  capturedOnOpen = undefined;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BellButton", () => {
  it("renders the bell button with a badge when initialCount > 0", () => {
    render(<BellButton initialCount={3} />);
    // Both desktop and mobile triggers render in jsdom; check at least one.
    const buttons = screen.getAllByRole("button", { name: /notificaciones/i });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    // Badge appears twice (once per trigger), use getAllByText.
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
  });

  it("renders without a badge when initialCount is 0", () => {
    render(<BellButton initialCount={0} />);
    // No badge text should be rendered at all.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows 99+ badge when count exceeds 99", () => {
    render(<BellButton initialCount={150} />);
    // At least one "99+" badge exists.
    expect(screen.getAllByText("99+").length).toBeGreaterThanOrEqual(1);
  });

  it("calls listNotifications when the desktop dropdown trigger is clicked", async () => {
    const user = userEvent.setup();
    mocks.listNotifications.mockResolvedValueOnce({
      items: [makeNotification(1), makeNotification(2), makeNotification(3)],
      nextCursor: null,
    });

    render(<BellButton initialCount={3} />);

    await user.click(getDesktopBellButton());

    await waitFor(() => {
      expect(mocks.listNotifications).toHaveBeenCalledWith({ limit: 10 });
    });
  });

  it("renders notification items returned by listNotifications", async () => {
    const user = userEvent.setup();
    mocks.listNotifications.mockResolvedValueOnce({
      items: [
        makeNotification(1, { title: "Alert A" }),
        makeNotification(2, { title: "Alert B" }),
        makeNotification(3, { title: "Alert C" }),
      ],
      nextCursor: null,
    });

    render(<BellButton initialCount={3} />);
    await user.click(getDesktopBellButton());

    await waitFor(() => {
      expect(screen.getAllByText("Alert A").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Alert B").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Alert C").length).toBeGreaterThan(0);
    });
  });

  it("calls markAsRead when clicking a notification row without actionUrl", async () => {
    const user = userEvent.setup();
    mocks.listNotifications.mockResolvedValueOnce({
      items: [makeNotification(42, { title: "ClickMe" })],
      nextCursor: null,
    });

    render(<BellButton initialCount={1} />);
    await user.click(getDesktopBellButton());

    await waitFor(() => screen.getAllByText("ClickMe"));

    // Find the row button that wraps our notification.
    const notifRow = screen
      .getAllByRole("button")
      .find((el) => el.textContent?.includes("ClickMe"));

    expect(notifRow).toBeDefined();
    if (notifRow) {
      await user.click(notifRow);
    }

    await waitFor(() => {
      expect(mocks.markAsRead).toHaveBeenCalledWith(42);
    });
  });

  it("calls markAllAsRead and resets count when 'Marcar todas' is clicked", async () => {
    const user = userEvent.setup();
    mocks.listNotifications.mockResolvedValueOnce({ items: [], nextCursor: null });
    mocks.markAllAsRead.mockResolvedValueOnce({ count: 5 });

    render(<BellButton initialCount={5} />);
    await user.click(getDesktopBellButton());

    await waitFor(() => screen.getAllByText(/marcar todas/i));

    const markAllButtons = screen.getAllByRole("button", { name: /marcar todas/i });
    await user.click(markAllButtons[0]);

    await waitFor(() => {
      expect(mocks.markAllAsRead).toHaveBeenCalled();
    });

    // Badge should disappear after count drops to 0.
    await waitFor(() => {
      expect(screen.queryByText("5")).not.toBeInTheDocument();
    });
  });

  it("increments count by 1 when an SSE notification:created event arrives", async () => {
    render(<BellButton initialCount={2} />);

    // Initially shows "2" badge.
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);

    act(() => {
      capturedHandler({
        type: "notification:created",
        userId: 1,
        audience: "user",
        notificationId: 99,
        payload: {
          type: "system",
          title: "New event",
          body: "Something happened",
          priority: "low",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("re-fetches unreadCount from server when onOpen callback fires", async () => {
    mocks.unreadCount.mockResolvedValueOnce({ count: 7 });

    render(<BellButton initialCount={0} />);

    // No badge initially.
    expect(screen.queryByText("7")).not.toBeInTheDocument();

    await act(async () => {
      capturedOnOpen?.();
    });

    await waitFor(() => {
      expect(mocks.unreadCount).toHaveBeenCalled();
      expect(screen.getAllByText("7").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("calls toast for high-priority SSE notification:created events", async () => {
    render(<BellButton initialCount={0} />);

    act(() => {
      capturedHandler({
        type: "notification:created",
        userId: 1,
        audience: "user",
        notificationId: 100,
        payload: {
          type: "system",
          title: "URGENT",
          body: "High priority alert",
          priority: "high",
        },
      });
    });

    await waitFor(() => {
      expect(mocks.toastFn).toHaveBeenCalledWith("URGENT", {
        description: "High priority alert",
      });
    });
  });
});
