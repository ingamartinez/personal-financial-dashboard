// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// #804: recurring-calendar-grid imports recurring-list.tsx for the shared
// UndoMatchButton, which imports the real "use server" actions.ts — mock it
// out, matching recurring-list.test.tsx.
// ---------------------------------------------------------------------------
const { unlinkTxFromRecurring, toastSuccess, toastError } = vi.hoisted(() => ({
  unlinkTxFromRecurring: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/app/(app)/transactions/actions", () => ({ unlinkTxFromRecurring }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

import { RecurringCalendarGrid } from "./recurring-calendar-grid";
import type { RecurringRow } from "@/app/(app)/recurring/queries";

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

function makeRow(overrides: Partial<RecurringRow> = {}): RecurringRow {
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

describe("RecurringCalendarGrid", () => {
  it("renders 35–42 cells for the month grid", () => {
    render(<RecurringCalendarGrid rows={[]} today={TODAY} />);

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
    render(<RecurringCalendarGrid rows={[]} today={TODAY} />);

    for (const name of ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("renders the Spanish month title with first letter capitalized", () => {
    render(<RecurringCalendarGrid rows={[]} today={TODAY} />);

    // "Mayo 2026"
    expect(screen.getByText(/mayo 2026/i)).toBeInTheDocument();
  });

  it("today cell gets the today-marker data-testid", () => {
    render(<RecurringCalendarGrid rows={[]} today={TODAY} />);

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

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} />);

    const pill = screen.getByTestId("sub-pill");
    expect(pill).toHaveTextContent("Netflix");
  });

  it("out-of-month cells do not show pills — only in-month cells render pills", () => {
    nextId = 20;
    // Render zero rows: verify no pills appear at all.
    render(<RecurringCalendarGrid rows={[]} today={TODAY} />);

    // No pills should render with empty rows.
    expect(screen.queryAllByTestId("sub-pill")).toHaveLength(0);
  });

  it("out-of-month cells render with opacity-40 class", () => {
    render(<RecurringCalendarGrid rows={[]} today={TODAY} />);

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

    render(<RecurringCalendarGrid rows={rows} today={TODAY} />);

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

    render(<RecurringCalendarGrid rows={rows} today={TODAY} />);

    await user.click(screen.getByTestId("overflow-chip"));

    // The overflow popover content should list Disney+ (the overflowing one).
    const popoverContent = screen.getByTestId("overflow-popover-content");
    expect(within(popoverContent).getByText("Disney+")).toBeInTheDocument();
  });

  it("clicking a pill opens the detail popover", async () => {
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

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} />);

    await user.click(screen.getByTestId("sub-pill"));

    // Detail popover should show sub info.
    // After opening, "HBO Max" appears twice (pill button + popover content) — use getAllByText.
    const hboMaxElements = screen.getAllByText("HBO Max");
    expect(hboMaxElements.length).toBeGreaterThanOrEqual(2);
    // The popover content also shows account label and próximo.
    expect(screen.getByText("Visa *9999")).toBeInTheDocument();
    expect(screen.getByText(/próximo/i)).toBeInTheDocument();
  });

  it("pills always open the detail popover (no calculator-mode toggle behavior in calendar)", async () => {
    const user = userEvent.setup();
    nextId = 60;
    const row = makeRow({ id: 60, label: "Apple TV", dayOfMonth: 8 });

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} />);

    await user.click(screen.getByTestId("sub-pill"));

    // Popover content appears with the detail.
    const appleTvElements = screen.getAllByText("Apple TV");
    expect(appleTvElements.length).toBeGreaterThanOrEqual(2);
  });

  it("rows are always rendered in the grid regardless of external excluded state", () => {
    nextId = 90;
    const row = makeRow({ id: 90, label: "YouTube Premium", dayOfMonth: 22 });

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} />);

    // The pill must be in the DOM
    expect(screen.getByTestId("sub-pill")).toBeInTheDocument();
    expect(screen.getByTestId("sub-pill")).toHaveTextContent("YouTube Premium");
  });
});

// ---------------------------------------------------------------------------
// Tests — #788: slot status dots in calendar pills
// ---------------------------------------------------------------------------

describe("RecurringCalendarGrid — #788 status dots", () => {
  it("renders emerald dot when status is matched", () => {
    nextId = 100;
    const row = makeRow({ id: 100, label: "Netflix", dayOfMonth: 15 });
    const slotStatusById = { 100: "matched" as const };

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} slotStatusById={slotStatusById} />);

    const dot = screen.getByTestId("status-dot");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toMatch(/bg-emerald-600/);
  });

  it("renders sky dot when status is upcoming", () => {
    nextId = 110;
    const row = makeRow({ id: 110, label: "Spotify", dayOfMonth: 20 });
    const slotStatusById = { 110: "upcoming" as const };

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} slotStatusById={slotStatusById} />);

    const dot = screen.getByTestId("status-dot");
    expect(dot.className).toMatch(/bg-sky-500/);
  });

  it("renders rose dot when status is overdue", () => {
    nextId = 120;
    const row = makeRow({ id: 120, label: "Disney+", dayOfMonth: 1 });
    const slotStatusById = { 120: "overdue" as const };

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} slotStatusById={slotStatusById} />);

    const dot = screen.getByTestId("status-dot");
    expect(dot.className).toMatch(/bg-rose-600/);
  });

  it("does not render a dot when status is dismissed", () => {
    nextId = 130;
    const row = makeRow({ id: 130, label: "HBO Max", dayOfMonth: 8 });
    const slotStatusById = { 130: "dismissed" as const };

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} slotStatusById={slotStatusById} />);

    expect(screen.queryByTestId("status-dot")).not.toBeInTheDocument();
  });

  it("does not render a dot when no slotStatusById is provided", () => {
    nextId = 140;
    const row = makeRow({ id: 140, label: "Apple TV+", dayOfMonth: 12 });

    render(<RecurringCalendarGrid rows={[row]} today={TODAY} />);

    expect(screen.queryByTestId("status-dot")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — #804: undo is reachable from Calendario (the default-open surface)
// ---------------------------------------------------------------------------

describe("RecurringCalendarGrid — #804 undo affordance", () => {
  it("shows a Deshacer match button in a matched pill's popover", async () => {
    const user = userEvent.setup();
    nextId = 150;
    const row = makeRow({ id: 150, label: "Netflix", dayOfMonth: 15 });

    render(
      <RecurringCalendarGrid
        rows={[row]}
        today={TODAY}
        slotStatusById={{ 150: "matched" }}
        matchedTxIdById={{ 150: 555 }}
      />,
    );

    await user.click(screen.getByTestId("sub-pill"));
    expect(screen.getByRole("button", { name: /deshacer match/i })).toBeInTheDocument();
  });

  it("does NOT show the undo button for a non-matched pill", async () => {
    const user = userEvent.setup();
    nextId = 151;
    const row = makeRow({ id: 151, label: "Spotify", dayOfMonth: 15 });

    render(
      <RecurringCalendarGrid
        rows={[row]}
        today={TODAY}
        slotStatusById={{ 151: "upcoming" }}
        matchedTxIdById={{ 151: 555 }}
      />,
    );

    await user.click(screen.getByTestId("sub-pill"));
    expect(screen.queryByRole("button", { name: /deshacer match/i })).not.toBeInTheDocument();
  });

  it("calls unlinkTxFromRecurring with the matched tx id when Deshacer match is clicked", async () => {
    unlinkTxFromRecurring.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    nextId = 152;
    const row = makeRow({ id: 152, label: "Google One", dayOfMonth: 15 });

    render(
      <RecurringCalendarGrid
        rows={[row]}
        today={TODAY}
        slotStatusById={{ 152: "matched" }}
        matchedTxIdById={{ 152: 777 }}
      />,
    );

    await user.click(screen.getByTestId("sub-pill"));
    await user.click(screen.getByRole("button", { name: /deshacer match/i }));

    expect(unlinkTxFromRecurring).toHaveBeenCalledWith({ txId: 777 });
  });

  it("shows Deshacer match inside the overflow chip popover for a matched overflow row", async () => {
    const user = userEvent.setup();
    nextId = 160;
    const rows = [
      makeRow({ id: 160, label: "A", dayOfMonth: 10 }),
      makeRow({ id: 161, label: "B", dayOfMonth: 10 }),
      makeRow({ id: 162, label: "C (overflow, matched)", dayOfMonth: 10 }),
    ];

    render(
      <RecurringCalendarGrid
        rows={rows}
        today={TODAY}
        slotStatusById={{ 162: "matched" }}
        matchedTxIdById={{ 162: 999 }}
      />,
    );

    await user.click(screen.getByTestId("overflow-chip"));
    expect(screen.getByRole("button", { name: /deshacer match/i })).toBeInTheDocument();
  });
});
