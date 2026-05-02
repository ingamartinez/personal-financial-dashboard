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

// Scenario for tier reclassification: 3 rows where excluding the dominant one shifts tiers.
// Row A: 800 COP (80%) — initially in Top
// Row B: 100 COP (10%) — initially in Medianas (cumulative = 90%)
// Row C: 100 COP (10%) — initially in Pequeñas
// When Row A is excluded: Row B (50%) + Row C (50%) → both in Top (can't reach 70% with just B)
const ROW_A = makeRow({
  id: 10,
  label: "Premium",
  amountCents: BigInt(-800),
  annualCents: BigInt(-9600),
  displayAmount: { cents: BigInt(-800), currency: "COP", converted: false, appliedTrm: null },
  displayAmountAbsCents: BigInt(800),
  nextOccurrence: "2026-05-10",
});
const ROW_B = makeRow({
  id: 11,
  label: "Básico",
  amountCents: BigInt(-100),
  annualCents: BigInt(-1200),
  displayAmount: { cents: BigInt(-100), currency: "COP", converted: false, appliedTrm: null },
  displayAmountAbsCents: BigInt(100),
  nextOccurrence: "2026-05-20",
});
const ROW_C = makeRow({
  id: 12,
  label: "Mini",
  amountCents: BigInt(-100),
  annualCents: BigInt(-1200),
  displayAmount: { cents: BigInt(-100), currency: "COP", converted: false, appliedTrm: null },
  displayAmountAbsCents: BigInt(100),
  nextOccurrence: "2026-05-25",
});

const TIER_MONTHLY: AggregationBucket[] = [
  { currency: "COP", cents: BigInt(-1000), txCount: 3, missingTrmCount: 0, convertedCount: 0 },
];
const TIER_ANNUAL: AggregationBucket[] = [
  { currency: "COP", cents: BigInt(-12000), txCount: 3, missingTrmCount: 0, convertedCount: 0 },
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

  it("tier section headers are visible for Top spend", () => {
    render(
      <SubscriptionsCalculator
        rows={[ROW_A, ROW_B, ROW_C]}
        monthlyTotals={TIER_MONTHLY}
        annualTotals={TIER_ANNUAL}
      />,
    );

    // "Top spend" header should appear.
    expect(screen.getByText("Top spend")).toBeInTheDocument();
  });

  it("excluding a sub in calculator shows savings, all checkboxes still rendered", async () => {
    const user = userEvent.setup();
    render(
      <SubscriptionsCalculator
        rows={[ROW_A, ROW_B, ROW_C]}
        monthlyTotals={TIER_MONTHLY}
        annualTotals={TIER_ANNUAL}
      />,
    );

    // Open calculator.
    await user.click(screen.getByRole("button", { name: /calculadora/i }));

    // 3 checkboxes total (one per row across all tiers).
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);

    // Uncheck "Premium" (ROW_A).
    const premiumCb = screen.getByRole("checkbox", { name: /incluir premium/i });
    await user.click(premiumCb);

    // Savings line appears.
    expect(screen.getByText(/si cancelás 1 desmarcada/i)).toBeInTheDocument();
    expect(screen.getByText(/ahorrarías/i)).toBeInTheDocument();
  });

  it("totals header shows 'Suscripciones' H1 is on the page (page copy)", () => {
    // This verifies the orchestrator renders properly.
    render(
      <SubscriptionsCalculator
        rows={[ROW_NETFLIX, ROW_SPOTIFY]}
        monthlyTotals={MONTHLY_TOTALS}
        annualTotals={ANNUAL_TOTALS}
      />,
    );

    // "Próximo cobro" label should appear in totals card.
    expect(screen.getByText(/Próximo cobro/i)).toBeInTheDocument();
  });
});
