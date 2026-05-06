// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RecurringList } from "./recurring-list";
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecurringList", () => {
  it("renders nothing when rows is empty", () => {
    render(<RecurringList rows={[]} excludedIds={new Set()} isCalculatorOpen={false} />);

    expect(screen.queryByTestId("recurring-list")).not.toBeInTheDocument();
  });

  it("renders one pill per row", () => {
    nextId = 1;
    const rows = [makeRow({ id: 1, label: "Netflix" }), makeRow({ id: 2, label: "Spotify" })];

    render(<RecurringList rows={rows} excludedIds={new Set()} isCalculatorOpen={false} />);

    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(screen.getAllByTestId("recurring-list-pill")).toHaveLength(2);
  });

  it("shows the dayOfMonth prominently in each pill", () => {
    nextId = 10;
    const row = makeRow({ id: 10, label: "Netflix", dayOfMonth: 15 });

    render(<RecurringList rows={[row]} excludedIds={new Set()} isCalculatorOpen={false} />);

    // Day number "15" should appear in the pill.
    expect(screen.getByText("15")).toBeInTheDocument();
  });

  it("in normal mode: clicking a pill opens the detail popover", async () => {
    const user = userEvent.setup();
    nextId = 20;
    const row = makeRow({
      id: 20,
      label: "HBO Max",
      accountLabel: "Mastercard *5555",
      dayOfMonth: 5,
      nextOccurrence: "2026-05-05",
    });

    render(<RecurringList rows={[row]} excludedIds={new Set()} isCalculatorOpen={false} />);

    await user.click(screen.getByTestId("recurring-list-pill"));

    // Popover with detail opens.
    expect(screen.getByText("Mastercard *5555")).toBeInTheDocument();
    expect(screen.getByText(/próximo/i)).toBeInTheDocument();
  });

  it("in calculator mode: clicking a pill calls onToggleExcluded", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    nextId = 30;
    const row = makeRow({ id: 30, label: "Apple TV", dayOfMonth: 8 });

    render(
      <RecurringList
        rows={[row]}
        excludedIds={new Set()}
        isCalculatorOpen={true}
        onToggleExcluded={onToggle}
      />,
    );

    await user.click(screen.getByTestId("recurring-list-pill"));
    expect(onToggle).toHaveBeenCalledWith(30);
  });

  it("in calculator mode: excluded pill renders with opacity-50 and line-through", () => {
    nextId = 40;
    const row = makeRow({ id: 40, label: "Paramount+", dayOfMonth: 12 });

    render(<RecurringList rows={[row]} excludedIds={new Set([40])} isCalculatorOpen={true} />);

    const pill = screen.getByTestId("recurring-list-pill");
    expect(pill.className).toMatch(/opacity-50/);
    // The label inside the pill gets line-through
    const label = pill.querySelector(".line-through");
    expect(label).toBeInTheDocument();
  });

  it("in calculator mode: non-excluded pill does not have opacity-50", () => {
    nextId = 50;
    const row = makeRow({ id: 50, label: "Crunchyroll", dayOfMonth: 18 });

    render(<RecurringList rows={[row]} excludedIds={new Set()} isCalculatorOpen={true} />);

    const pill = screen.getByTestId("recurring-list-pill");
    expect(pill.className).not.toMatch(/opacity-50/);
  });

  it("renders all rows in given order (sorted by caller — dayOfMonth asc)", () => {
    nextId = 60;
    const rows = [
      makeRow({ id: 60, label: "A", dayOfMonth: 1 }),
      makeRow({ id: 61, label: "B", dayOfMonth: 10 }),
      makeRow({ id: 62, label: "C", dayOfMonth: 25 }),
    ];

    render(<RecurringList rows={rows} excludedIds={new Set()} isCalculatorOpen={false} />);

    const pills = screen.getAllByTestId("recurring-list-pill");
    expect(pills[0]).toHaveTextContent("A");
    expect(pills[1]).toHaveTextContent("B");
    expect(pills[2]).toHaveTextContent("C");
  });
});
