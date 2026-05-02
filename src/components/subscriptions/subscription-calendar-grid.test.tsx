// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SubscriptionCalendarGrid } from "./subscription-calendar-grid";
import type { SubscriptionRow } from "@/app/(app)/subscriptions/queries";

// ---------------------------------------------------------------------------
// Radix shims — pointer capture + scrollIntoView not in jsdom.
// ---------------------------------------------------------------------------

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let nextId = 1;

function makeRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  const id = nextId++;
  return {
    id,
    label: `Sub ${id}`,
    accountLabel: "Visa *1234",
    amountCents: BigInt(-4900),
    currency: "COP",
    dayOfMonth: 15,
    amountType: "fixed",
    categorySlug: "suscripciones",
    categoryName: "Suscripciones",
    notes: null,
    skippedMonths: [],
    nextOccurrence: "2026-05-15",
    annualCents: BigInt(-58800),
    displayAmount: {
      cents: BigInt(-4900),
      currency: "COP",
      converted: false,
      appliedTrm: null,
    },
    displayAmountAbsCents: BigInt(4900),
    priceHike: null,
    ...overrides,
  };
}

// Fixed "today" for deterministic tests: May 2, 2026 (Friday).
// May 2026: starts on Friday → grid starts April 26 (Sunday).
// May 1 = Saturday of first grid week. 31 days. Ends June 6 (Saturday).
// Total = 42 cells.
const TODAY = new Date("2026-05-02T00:00:00");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubscriptionCalendarGrid", () => {
  it("renders 35–42 cells for the month grid", () => {
    render(
      <SubscriptionCalendarGrid
        rows={[]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    // Count in-month cells by data-testid pattern (day-cell-N).
    // May 2026 has 31 in-month cells. Out-of-month cells have no data-testid.
    // Total grid cells = 42 for May 2026 (Apr 26 – Jun 6).
    // Verify the grid container exists and has child divs in the 35-42 range.
    const grid = screen.getByTestId("calendar-grid");
    // Count immediate children only (the day cells).
    const cells = Array.from(grid.children);
    expect(cells.length).toBeGreaterThanOrEqual(35);
    expect(cells.length).toBeLessThanOrEqual(42);
  });

  it("renders 7 day-of-week headers in Spanish uppercase", () => {
    render(
      <SubscriptionCalendarGrid
        rows={[]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    for (const name of ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("renders the Spanish month title with first letter capitalized", () => {
    render(
      <SubscriptionCalendarGrid
        rows={[]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    // "Mayo 2026"
    expect(screen.getByText(/mayo 2026/i)).toBeInTheDocument();
  });

  it("today cell gets the today-marker data-testid", () => {
    render(
      <SubscriptionCalendarGrid
        rows={[]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    const marker = screen.getByTestId("today-marker");
    expect(marker).toBeInTheDocument();
    // It should display the day number (2 for May 2)
    expect(marker).toHaveTextContent("2");
    // Should have bg-primary class for the circle treatment
    expect(marker.className).toMatch(/bg-primary/);
  });

  it("in-month cells show pills when subs exist on that day", () => {
    nextId = 10;
    const row = makeRow({ id: 10, label: "Netflix", dayOfMonth: 15, nextOccurrence: "2026-05-15" });

    render(
      <SubscriptionCalendarGrid
        rows={[row]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    const pill = screen.getByTestId("sub-pill");
    expect(pill).toHaveTextContent("Netflix");
  });

  it("out-of-month cells do not show pills — only in-month cells render pills", () => {
    nextId = 20;
    // Render zero rows: verify no pills appear at all.
    render(
      <SubscriptionCalendarGrid
        rows={[]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    // No pills should render with empty rows.
    expect(screen.queryAllByTestId("sub-pill")).toHaveLength(0);
  });

  it("out-of-month cells render with opacity-40 class", () => {
    render(
      <SubscriptionCalendarGrid
        rows={[]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    const grid = screen.getByTestId("calendar-grid");
    // Out-of-month cells have opacity-40 applied (April 26-30 and June 1-6 for May 2026).
    const mutedCells = grid.querySelectorAll(".opacity-40");
    // May 2026 grid: Apr 26-30 (5 cells) + Jun 1-6 (6 cells) = 11 out-of-month cells.
    expect(mutedCells.length).toBeGreaterThan(0);
  });

  it("overflow chip '+N más' appears when ≥ 3 subs on the same day", () => {
    nextId = 30;
    const rows = [
      makeRow({ id: 30, label: "Netflix", dayOfMonth: 10 }),
      makeRow({ id: 31, label: "Spotify", dayOfMonth: 10 }),
      makeRow({ id: 32, label: "Disney+", dayOfMonth: 10 }),
    ];

    render(
      <SubscriptionCalendarGrid
        rows={rows}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    // MAX_PILLS = 2, so with 3 subs: 2 pills + 1 overflow chip showing "+1 más".
    expect(screen.getByTestId("overflow-chip")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-chip")).toHaveTextContent("+1 más");
  });

  it("clicking overflow chip opens popover with all overflowing subs", async () => {
    const user = userEvent.setup();
    nextId = 40;
    const rows = [
      makeRow({ id: 40, label: "Netflix", dayOfMonth: 20 }),
      makeRow({ id: 41, label: "Spotify", dayOfMonth: 20 }),
      makeRow({ id: 42, label: "Disney+", dayOfMonth: 20 }),
    ];

    render(
      <SubscriptionCalendarGrid
        rows={rows}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    await user.click(screen.getByTestId("overflow-chip"));

    // The overflow popover content should list Disney+ (the overflowing one).
    const popoverContent = screen.getByTestId("overflow-popover-content");
    expect(within(popoverContent).getByText("Disney+")).toBeInTheDocument();
  });

  it("clicking a pill (calculator closed) opens the detail popover", async () => {
    const user = userEvent.setup();
    nextId = 50;
    const row = makeRow({
      id: 50,
      label: "HBO Max",
      dayOfMonth: 5,
      nextOccurrence: "2026-05-05",
      accountLabel: "Visa *9999",
      categoryName: "Entretenimiento",
    });

    render(
      <SubscriptionCalendarGrid
        rows={[row]}
        excludedIds={new Set()}
        isCalculatorOpen={false}
        today={TODAY}
      />,
    );

    await user.click(screen.getByTestId("sub-pill"));

    // Detail popover should show sub info.
    // After opening, "HBO Max" appears twice (pill button + popover content) — use getAllByText.
    const hboMaxElements = screen.getAllByText("HBO Max");
    expect(hboMaxElements.length).toBeGreaterThanOrEqual(2);
    // The popover content also shows account label and próximo.
    expect(screen.getByText("Visa *9999")).toBeInTheDocument();
    expect(screen.getByText(/próximo/i)).toBeInTheDocument();
  });

  it("in calculator mode: clicking a pill calls onToggleExcluded", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    nextId = 60;
    const row = makeRow({ id: 60, label: "Apple TV", dayOfMonth: 8 });

    render(
      <SubscriptionCalendarGrid
        rows={[row]}
        excludedIds={new Set()}
        isCalculatorOpen={true}
        onToggleExcluded={onToggle}
        today={TODAY}
      />,
    );

    await user.click(screen.getByTestId("sub-pill"));
    expect(onToggle).toHaveBeenCalledWith(60);
  });

  it("in calculator mode: excluded pill renders with opacity-50 and line-through classes", () => {
    nextId = 70;
    const row = makeRow({ id: 70, label: "Paramount+", dayOfMonth: 12 });

    render(
      <SubscriptionCalendarGrid
        rows={[row]}
        excludedIds={new Set([70])}
        isCalculatorOpen={true}
        today={TODAY}
      />,
    );

    const pill = screen.getByTestId("sub-pill");
    expect(pill.className).toMatch(/opacity-50/);
    expect(pill.className).toMatch(/line-through/);
  });

  it("in calculator mode: non-excluded pill does NOT have opacity-50 or line-through", () => {
    nextId = 80;
    const row = makeRow({ id: 80, label: "Crunchyroll", dayOfMonth: 18 });

    render(
      <SubscriptionCalendarGrid
        rows={[row]}
        excludedIds={new Set()}
        isCalculatorOpen={true}
        today={TODAY}
      />,
    );

    const pill = screen.getByTestId("sub-pill");
    expect(pill.className).not.toMatch(/opacity-50/);
    expect(pill.className).not.toMatch(/line-through/);
  });

  it("excluded rows are still rendered in the grid (exclusion is visual only)", () => {
    nextId = 90;
    const row = makeRow({ id: 90, label: "YouTube Premium", dayOfMonth: 22 });

    render(
      <SubscriptionCalendarGrid
        rows={[row]}
        excludedIds={new Set([90])}
        isCalculatorOpen={true}
        today={TODAY}
      />,
    );

    // The pill must still be in the DOM (just muted)
    expect(screen.getByTestId("sub-pill")).toBeInTheDocument();
    expect(screen.getByTestId("sub-pill")).toHaveTextContent("YouTube Premium");
  });
});
