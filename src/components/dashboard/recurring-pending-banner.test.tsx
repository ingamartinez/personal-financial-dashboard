// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted mocks — countPendingOccurrences is the only external dep.
// ---------------------------------------------------------------------------
const { countPendingOccurrences } = vi.hoisted(() => ({
  countPendingOccurrences: vi.fn<() => Promise<number>>(),
}));

vi.mock("@/lib/recurring/expected-occurrences", () => ({ countPendingOccurrences }));

// Import AFTER mocks.
import { RecurringPendingBanner } from "./recurring-pending-banner";

// ---------------------------------------------------------------------------
// Radix shims (safe to have even if not needed — Belt and suspenders).
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
  countPendingOccurrences.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helper to render an async server component.
// RTL can render async components when wrapped in act().
// ---------------------------------------------------------------------------
async function renderBanner(userId = 1) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(await RecurringPendingBanner({ userId }));
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecurringPendingBanner", () => {
  it("renders nothing when count is 0", async () => {
    countPendingOccurrences.mockResolvedValueOnce(0);

    const { container } = await renderBanner(42);

    // Banner returns null when count === 0.
    expect(container.firstChild).toBeNull();
  });

  it("renders the banner when count is 1 with singular text", async () => {
    countPendingOccurrences.mockResolvedValueOnce(1);

    await renderBanner(42);

    expect(screen.getByText(/tenés 1 recurrente pendiente de resolver/i)).toBeInTheDocument();
  });

  it("renders the banner with plural text when count > 1", async () => {
    countPendingOccurrences.mockResolvedValueOnce(5);

    await renderBanner(42);

    expect(screen.getByText(/tenés 5 recurrentes pendientes de resolver/i)).toBeInTheDocument();
  });

  it("renders the 'Ir a transacciones' link with correct href for current month", async () => {
    countPendingOccurrences.mockResolvedValueOnce(3);

    await renderBanner(7);

    const link = screen.getByRole("link", { name: /ir a transacciones/i });
    expect(link).toBeInTheDocument();

    // href must point to /transactions with from= and to= for the current month.
    const href = link.getAttribute("href") ?? "";
    expect(href).toMatch(/^\/transactions\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
  });

  it("passes the userId to countPendingOccurrences", async () => {
    countPendingOccurrences.mockResolvedValueOnce(2);

    await renderBanner(99);

    expect(countPendingOccurrences).toHaveBeenCalledWith(99, expect.any(Date));
  });

  it("banner has correct accessible role and label", async () => {
    countPendingOccurrences.mockResolvedValueOnce(4);

    await renderBanner(1);

    const aside = screen.getByRole("note", { name: /recurrentes pendientes/i });
    expect(aside).toBeInTheDocument();
    expect(aside).toHaveAttribute("data-testid", "recurring-pending-banner");
  });
});
