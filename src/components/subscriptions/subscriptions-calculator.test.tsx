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
});
const ROW_SPOTIFY = makeRow({
  id: 2,
  label: "Spotify",
  amountCents: BigInt(-2600),
  annualCents: BigInt(-31200),
  displayAmount: { cents: BigInt(-2600), currency: "COP", converted: false, appliedTrm: null },
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

    // No checkboxes rendered.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

    // No savings lines.
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ahorrarías/i)).not.toBeInTheDocument();
  });

  it("click Calculadora — checkboxes appear, all checked", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    for (const cb of checkboxes) {
      expect(cb).toBeChecked();
    }

    // Savings lines not shown when none excluded.
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ahorrarías/i)).not.toBeInTheDocument();
  });

  it("uncheck one row — savings lines appear with correct count", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    // Uncheck Netflix (first checkbox).
    const [netflixCb] = screen.getAllByRole("checkbox");
    await user.click(netflixCb);

    expect(screen.getByText(/si cancelás 1 desmarcada/i)).toBeInTheDocument();
    expect(screen.getByText(/ahorrarías/i)).toBeInTheDocument();
  });

  it("Marcar todas — all checked, savings lines disappear", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    // Uncheck Netflix.
    const [netflixCb] = screen.getAllByRole("checkbox");
    await user.click(netflixCb);

    // "Marcar todas" button should appear.
    const markAllBtn = screen.getByRole("button", { name: /marcar todas/i });
    await user.click(markAllBtn);

    // All checkboxes checked again.
    for (const cb of screen.getAllByRole("checkbox")) {
      expect(cb).toBeChecked();
    }

    // Savings lines gone.
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ahorrarías/i)).not.toBeInTheDocument();
  });

  it("Cerrar calculadora — checkboxes disappear, reopening shows all checked", async () => {
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

    // Uncheck Netflix so state is dirty.
    const [netflixCb] = screen.getAllByRole("checkbox");
    await user.click(netflixCb);
    expect(screen.getByText(/si cancelás/i)).toBeInTheDocument();

    // Close calculator.
    await user.click(screen.getByRole("button", { name: /cerrar calculadora/i }));

    // Checkboxes gone.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByText(/si cancelás/i)).not.toBeInTheDocument();

    // Reopen — all should be checked (state reset on close).
    await user.click(screen.getByRole("button", { name: /calculadora/i }));
    for (const cb of screen.getAllByRole("checkbox")) {
      expect(cb).toBeChecked();
    }
  });
});
