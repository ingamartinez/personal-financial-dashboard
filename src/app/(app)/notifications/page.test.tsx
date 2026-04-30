// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted shared mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const markAsRead = vi.fn<() => Promise<{ ok: boolean }>>();
  const markAllAsRead = vi.fn<() => Promise<{ count: number }>>();
  const toastError = vi.fn();
  const routerRefresh = vi.fn();

  return { markAsRead, markAllAsRead, toastError, routerRefresh };
});

vi.mock("@/app/(app)/notifications/actions", () => ({
  markAsRead: mocks.markAsRead,
  markAllAsRead: mocks.markAllAsRead,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: mocks.toastError }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.routerRefresh }),
  usePathname: () => "/notifications",
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { FilterPills, NotificationsListView } from "./_components/notifications-list-view";
import type { NotificationRow } from "./_types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeNotification(id: number, overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id,
    type: "system",
    entityId: `entity-${id}`,
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
// NotificationsListView — empty state
// ---------------------------------------------------------------------------

describe("NotificationsListView — empty state", () => {
  it("renders the empty state when items is empty", () => {
    render(<NotificationsListView items={[]} nextCursor={null} currentFilter="all" />);

    expect(screen.getByText("No tenés notificaciones")).toBeInTheDocument();
    expect(screen.getByText("Cuando algo importante pase, vas a verlo acá")).toBeInTheDocument();
  });

  it("does NOT render Marcar todas cuando no hay items", () => {
    render(<NotificationsListView items={[]} nextCursor={null} currentFilter="all" />);

    expect(
      screen.queryByRole("button", { name: /Marcar todas como leídas/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// NotificationsListView — list rendering
// ---------------------------------------------------------------------------

describe("NotificationsListView — list rendering", () => {
  it("renders 3 notifications with title, body and relative time", () => {
    const items = [
      makeNotification(1, { title: "Primera notif" }),
      makeNotification(2, { title: "Segunda notif" }),
      makeNotification(3, { title: "Tercera notif" }),
    ];

    render(<NotificationsListView items={items} nextCursor={null} currentFilter="all" />);

    expect(screen.getByText("Primera notif")).toBeInTheDocument();
    expect(screen.getByText("Segunda notif")).toBeInTheDocument();
    expect(screen.getByText("Tercera notif")).toBeInTheDocument();
    expect(screen.getByText("Body of notification 1")).toBeInTheDocument();
  });

  it("renders priority dots for each notification", () => {
    const items = [
      makeNotification(1, { priority: "high" }),
      makeNotification(2, { priority: "medium" }),
      makeNotification(3, { priority: "low" }),
    ];

    render(<NotificationsListView items={items} nextCursor={null} currentFilter="all" />);

    const dots = screen.getAllByLabelText(/Prioridad/i);
    expect(dots).toHaveLength(3);
  });

  it("read rows have muted styling", () => {
    const readItem = makeNotification(1, {
      title: "Read notification",
      readAt: new Date("2026-04-29T09:00:00Z"),
    });

    render(<NotificationsListView items={[readItem]} nextCursor={null} currentFilter="all" />);

    // The title element should have muted styling (text-muted-foreground).
    const titleEl = screen.getByText("Read notification");
    expect(titleEl.className).toMatch(/muted/);
  });

  it("unread rows do NOT have read muted styling", () => {
    const unreadItem = makeNotification(1, {
      title: "Unread notification",
      readAt: null,
    });

    render(<NotificationsListView items={[unreadItem]} nextCursor={null} currentFilter="all" />);

    const titleEl = screen.getByText("Unread notification");
    // unread titles get font-semibold and text-foreground, NOT text-muted-foreground
    expect(titleEl.className).not.toMatch(/muted/);
  });

  it("renders Ir → link when actionUrl is present", () => {
    const item = makeNotification(1, { actionUrl: "/transactions?highlight=42" });

    render(<NotificationsListView items={[item]} nextCursor={null} currentFilter="all" />);

    const link = screen.getByRole("link", { name: "Ir →" });
    expect(link).toHaveAttribute("href", "/transactions?highlight=42");
  });

  it("does NOT render Ir → link when actionUrl is null", () => {
    const item = makeNotification(1, { actionUrl: null });

    render(<NotificationsListView items={[item]} nextCursor={null} currentFilter="all" />);

    expect(screen.queryByRole("link", { name: "Ir →" })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// NotificationsListView — pagination
// ---------------------------------------------------------------------------

describe("NotificationsListView — pagination", () => {
  it("shows Cargar más button when nextCursor is not null", () => {
    render(
      <NotificationsListView items={[makeNotification(1)]} nextCursor={99} currentFilter="all" />,
    );

    expect(screen.getByRole("link", { name: /Cargar más/i })).toBeInTheDocument();
  });

  it("hides Cargar más button when nextCursor is null", () => {
    render(
      <NotificationsListView items={[makeNotification(1)]} nextCursor={null} currentFilter="all" />,
    );

    expect(screen.queryByRole("link", { name: /Cargar más/i })).not.toBeInTheDocument();
  });

  it("Cargar más link includes cursor AND preserves current filter", () => {
    render(
      <NotificationsListView
        items={[makeNotification(1)]}
        nextCursor={42}
        currentFilter="unread"
      />,
    );

    const link = screen.getByRole("link", { name: /Cargar más/i });
    expect(link).toHaveAttribute("href", "/notifications?filter=unread&cursor=42");
  });
});

// ---------------------------------------------------------------------------
// NotificationsListView — mark all as read footer
// ---------------------------------------------------------------------------

describe("NotificationsListView — mark all as read", () => {
  it("shows Marcar todas cuando hay al menos una notificación no leída", () => {
    const items = [
      makeNotification(1, { readAt: null }),
      makeNotification(2, { readAt: new Date() }),
    ];

    render(<NotificationsListView items={items} nextCursor={null} currentFilter="all" />);

    expect(screen.getByRole("button", { name: /Marcar todas como leídas/i })).toBeInTheDocument();
  });

  it("does NOT show Marcar todas cuando todas están leídas", () => {
    const items = [
      makeNotification(1, { readAt: new Date() }),
      makeNotification(2, { readAt: new Date() }),
    ];

    render(<NotificationsListView items={items} nextCursor={null} currentFilter="all" />);

    expect(
      screen.queryByRole("button", { name: /Marcar todas como leídas/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// FilterPills — active pill highlighting
// ---------------------------------------------------------------------------

describe("FilterPills", () => {
  it("marks the active filter pill with aria-current=page", () => {
    render(<FilterPills currentFilter="unread" />);

    const unreadPill = screen.getByRole("link", { name: "No leídas" });
    expect(unreadPill).toHaveAttribute("aria-current", "page");

    const allPill = screen.getByRole("link", { name: "Todas" });
    expect(allPill).not.toHaveAttribute("aria-current");
  });

  it("marks Acción requerida pill active when filter=high", () => {
    render(<FilterPills currentFilter="high" />);

    const highPill = screen.getByRole("link", { name: "Acción requerida" });
    expect(highPill).toHaveAttribute("aria-current", "page");
  });

  it("marks Todas pill active by default (filter=all)", () => {
    render(<FilterPills currentFilter="all" />);

    const allPill = screen.getByRole("link", { name: "Todas" });
    expect(allPill).toHaveAttribute("aria-current", "page");
  });

  it("filter pills link to the correct URL", () => {
    render(<FilterPills currentFilter="all" />);

    expect(screen.getByRole("link", { name: "Todas" })).toHaveAttribute(
      "href",
      "/notifications?filter=all",
    );
    expect(screen.getByRole("link", { name: "No leídas" })).toHaveAttribute(
      "href",
      "/notifications?filter=unread",
    );
    expect(screen.getByRole("link", { name: "Acción requerida" })).toHaveAttribute(
      "href",
      "/notifications?filter=high",
    );
  });
});
