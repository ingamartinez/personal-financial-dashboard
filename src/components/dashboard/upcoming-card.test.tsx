// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted mocks — all heavy deps mocked before any import.
// ---------------------------------------------------------------------------
const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Mock ForecastLinkTxDialog — we only want to verify it opens, not test the full dialog.
const { mockDialogOpen } = vi.hoisted(() => ({ mockDialogOpen: vi.fn() }));
vi.mock("@/components/transactions/forecast-link-tx-dialog", () => ({
  ForecastLinkTxDialog: ({
    open,
    onOpenChange,
    label,
  }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    label: string;
  }) => {
    mockDialogOpen(open);
    return open ? (
      <div data-testid="forecast-link-dialog" data-label={label}>
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null;
  },
}));

// ---------------------------------------------------------------------------
// Radix shims (pointer-capture + scrollIntoView).
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
  mockDialogOpen.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Import AFTER mocks.
// ---------------------------------------------------------------------------
import { UpcomingCard } from "./upcoming-card";
import type { UpcomingCardItem } from "./upcoming-card";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<UpcomingCardItem> = {}): UpcomingCardItem {
  return {
    recurringId: 1,
    label: "Arriendo",
    accountId: 10,
    accountName: "Bancolombia Ahorros",
    amountCents: "-150000000",
    currency: "COP",
    categorySlug: "housing",
    categoryName: "Vivienda",
    dayOfMonth: 5,
    expectedOn: "2026-04-05",
    status: "upcoming",
    matchedTransactionId: null,
    yearMonth: "2026-04",
    notes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpcomingCard", () => {
  it("renders empty state when items list is empty", () => {
    render(<UpcomingCard items={[]} />);
    expect(
      screen.getByText(/Sin recurrentes pendientes/i),
    ).toBeInTheDocument();
  });

  it("renders item labels and amounts", () => {
    const items = [
      makeItem({ label: "Arriendo", amountCents: "-150000000" }),
      makeItem({ recurringId: 2, label: "Internet", amountCents: "-8000000", yearMonth: "2026-04" }),
    ];
    render(<UpcomingCard items={items} />);
    expect(screen.getByText("Arriendo")).toBeInTheDocument();
    expect(screen.getByText("Internet")).toBeInTheDocument();
  });

  it("clicking the link button opens ForecastLinkTxDialog with correct label", () => {
    const item = makeItem({ label: "Netflix", recurringId: 42, yearMonth: "2026-04" });
    render(<UpcomingCard items={[item]} />);

    const linkBtn = screen.getByRole("button", { name: /Asociar tx a Netflix/i });
    fireEvent.click(linkBtn);

    // Dialog should now be open with the correct label.
    const dialog = screen.getByTestId("forecast-link-dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-label")).toBe("Netflix");
  });

  it("renders overdue status badge", () => {
    const item = makeItem({ status: "overdue", label: "Overdue Item" });
    render(<UpcomingCard items={[item]} />);
    expect(screen.getByText("atrasado")).toBeInTheDocument();
  });

  it("renders upcoming status badge", () => {
    const item = makeItem({ status: "upcoming", label: "Upcoming Item" });
    render(<UpcomingCard items={[item]} />);
    expect(screen.getByText("pendiente")).toBeInTheDocument();
  });

  it("renders windowLabel in card description when provided", () => {
    render(<UpcomingCard items={[]} windowLabel="±5d desde hoy" />);
    expect(screen.getByText(/±5d desde hoy/)).toBeInTheDocument();
  });

  it("dialog closes when close button is clicked", () => {
    const item = makeItem({ label: "Gym", recurringId: 7 });
    render(<UpcomingCard items={[item]} />);

    const linkBtn = screen.getByRole("button", { name: /Asociar tx a Gym/i });
    fireEvent.click(linkBtn);

    // Dialog open.
    expect(screen.getByTestId("forecast-link-dialog")).toBeInTheDocument();

    // Close it.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("forecast-link-dialog")).not.toBeInTheDocument();
  });

  it("renders up to N items without overflow (max-h scroll container present)", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      makeItem({
        recurringId: i + 1,
        label: `Recurring ${i + 1}`,
        yearMonth: "2026-04",
      }),
    );
    render(<UpcomingCard items={items} />);
    // All 8 items rendered
    for (let i = 1; i <= 8; i++) {
      expect(screen.getByText(`Recurring ${i}`)).toBeInTheDocument();
    }
    // Scroll container present (max-h-72)
    const list = document.querySelector("ul");
    expect(list?.className).toMatch(/max-h/);
  });
});
