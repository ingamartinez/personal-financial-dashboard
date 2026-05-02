// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SubscriptionsCalculator } from "./subscriptions-calculator";
import type { SubscriptionRow } from "@/app/(app)/subscriptions/queries";
import type { AggregationBucket } from "@/lib/fx/aggregate";

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
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 1,
    label: "Netflix",
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

const ROW_NETFLIX = makeRow({
  id: 1,
  label: "Netflix",
  amountCents: BigInt(-4900),
  annualCents: BigInt(-58800),
  displayAmount: { cents: BigInt(-4900), currency: "COP", converted: false, appliedTrm: null },
  displayAmountAbsCents: BigInt(4900),
});
const ROW_SPOTIFY = makeRow({
  id: 2,
  label: "Spotify",
  amountCents: BigInt(-2600),
  annualCents: BigInt(-31200),
  displayAmount: { cents: BigInt(-2600), currency: "COP", converted: false, appliedTrm: null },
  displayAmountAbsCents: BigInt(2600),
});

const MONTHLY_TOTALS: AggregationBucket[] = [
  { currency: "COP", cents: BigInt(-7500), txCount: 2, missingTrmCount: 0, convertedCount: 0 },
];
const ANNUAL_TOTALS: AggregationBucket[] = [
  { currency: "COP", cents: BigInt(-90000), txCount: 2, missingTrmCount: 0, convertedCount: 0 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubscriptionsCalculator", () => {
  it("renders closed by default — no checkboxes, only Calculadora button", () => {
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    // Calculator button is visible.
    expect(screen.getByRole("button", { name: /calculadora/i })).toBeInTheDocument();

    // No savings lines.
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ahorrarías/i)).not.toBeInTheDocument();
  });

  it("renders the calendar grid", () => {
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    // Calendar grid must be present.
    expect(screen.getByTestId("subscription-calendar-grid")).toBeInTheDocument();
  });

  it("grid shows subscription pills for rows", () => {
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    // Both subs are on day 15 — they should appear as pills in the grid.
    const pills = screen.getAllByTestId("sub-pill");
    expect(pills.length).toBeGreaterThanOrEqual(1);
  });

  it("click Calculadora — calculator opens, grid is in calculator mode", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    // Calculator is open when "Cerrar calculadora" button is visible.
    expect(screen.getByRole("button", { name: /cerrar calculadora/i })).toBeInTheDocument();

    // Grid is still rendered.
    expect(screen.getByTestId("subscription-calendar-grid")).toBeInTheDocument();

    // Savings lines not shown when none excluded.
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ahorrarías/i)).not.toBeInTheDocument();
  });

  it("in calculator mode: clicking a pill toggles exclusion and shows savings", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    // Click the first pill to exclude it.
    const pills = screen.getAllByTestId("sub-pill");
    await user.click(pills[0]);

    // Savings lines appear.
    expect(screen.getByText(/si cancelás 1 desmarcada/i)).toBeInTheDocument();
    expect(screen.getByText(/ahorrarías/i)).toBeInTheDocument();
  });

  it("in calculator mode: excluded pill gets muted visual state", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    const pills = screen.getAllByTestId("sub-pill");
    await user.click(pills[0]);

    // The clicked pill should now have opacity-50 applied.
    expect(pills[0].className).toMatch(/opacity-50/);
  });

  it("Marcar todas — re-includes all, savings lines disappear", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    // Exclude one pill.
    const pills = screen.getAllByTestId("sub-pill");
    await user.click(pills[0]);
    expect(screen.getByText(/si cancelás/i)).toBeInTheDocument();

    // "Marcar todas" button should appear.
    const markAllBtn = screen.getByRole("button", { name: /marcar todas/i });
    await user.click(markAllBtn);

    // Savings lines gone.
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ahorrarías/i)).not.toBeInTheDocument();
  });

  it("Cerrar calculadora — returns to normal mode", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    // Open calculator.
    await user.click(screen.getByRole("button", { name: /calculadora/i }));
    expect(screen.getByRole("button", { name: /cerrar calculadora/i })).toBeInTheDocument();

    // Close calculator.
    await user.click(screen.getByRole("button", { name: /cerrar calculadora/i }));

    // Calculadora button is back, close button is gone.
    expect(screen.getByRole("button", { name: /calculadora/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cerrar calculadora/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();
  });

  it("totals card shows próximo cobro", () => {
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    expect(screen.getByText(/Próximo cobro/i)).toBeInTheDocument();
  });

  it("renders empty state when rows is empty", () => {
    render(<SubscriptionsCalculator rows={[]} monthlyTotals={[]} annualTotals={[]} />);

    expect(screen.getByText(/no hay suscripciones activas/i)).toBeInTheDocument();
  });
});
