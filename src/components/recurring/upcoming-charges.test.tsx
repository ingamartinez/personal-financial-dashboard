// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { UpcomingCharges } from "./upcoming-charges";
import type { RecurringRow } from "@/app/(app)/recurring/queries";

// ---------------------------------------------------------------------------
// Radix + jsdom shims
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
    accountLabel: "Cuenta",
    amountCents: BigInt(-50000),
    currency: "COP",
    dayOfMonth: 15,
    amountType: "fixed",
    categorySlug: "suscripciones",
    categoryName: "Suscripciones",
    notes: null,
    skippedMonths: [],
    nextOccurrence: "2026-05-15",
    annualCents: BigInt(-600000),
    displayAmount: {
      cents: BigInt(-50000),
      currency: "COP",
      converted: false,
      appliedTrm: null,
    },
    displayAmountAbsCents: BigInt(50000),
    priceHike: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpcomingCharges", () => {
  it("returns null when no charges in next 7 days", () => {
    // today = 2026-05-02, subs that charge on day 15 → nextOccurrence = 2026-05-15 (13 days away)
    const today = new Date("2026-05-02T12:00:00");
    const rows = [makeRow({ nextOccurrence: "2026-05-15" })];
    const { container } = render(
      <UpcomingCharges rows={rows} excludedIds={new Set()} today={today} />,
    );
    // Nothing rendered
    expect(container.firstChild).toBeNull();
  });

  it("shows upcoming charges within 7 days", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 1;
    const rows = [makeRow({ id: 1, label: "Netflix", nextOccurrence: "2026-05-13" })];
    render(<UpcomingCharges rows={rows} excludedIds={new Set()} today={today} />);

    expect(screen.getByText("Próximos 7 días")).toBeInTheDocument();
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText(/en 3 días/)).toBeInTheDocument();
  });

  it("shows 'hoy' when charge is today", () => {
    const today = new Date("2026-05-15T12:00:00");
    nextId = 10;
    const rows = [makeRow({ id: 10, label: "Spotify", nextOccurrence: "2026-05-15" })];
    render(<UpcomingCharges rows={rows} excludedIds={new Set()} today={today} />);

    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText(/hoy/)).toBeInTheDocument();
  });

  it("excludes rows in excludedIds", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 20;
    const rows = [
      makeRow({ id: 20, label: "Netflix", nextOccurrence: "2026-05-12" }),
      makeRow({ id: 21, label: "Spotify", nextOccurrence: "2026-05-14" }),
    ];
    render(<UpcomingCharges rows={rows} excludedIds={new Set([20])} today={today} />);

    expect(screen.queryByText("Netflix")).not.toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
  });

  it("hides when all upcoming are excluded", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 30;
    const rows = [makeRow({ id: 30, label: "Netflix", nextOccurrence: "2026-05-12" })];
    const { container } = render(
      <UpcomingCharges rows={rows} excludedIds={new Set([30])} today={today} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows 'mañana' when charge is tomorrow", () => {
    const today = new Date("2026-05-14T12:00:00");
    nextId = 40;
    const rows = [makeRow({ id: 40, label: "Disney+", nextOccurrence: "2026-05-15" })];
    render(<UpcomingCharges rows={rows} excludedIds={new Set()} today={today} />);

    expect(screen.getByText("Disney+")).toBeInTheDocument();
    expect(screen.getByText(/mañana/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — #788: slotStatusById dots in UpcomingCharges
// ---------------------------------------------------------------------------

describe("UpcomingCharges — #788 status dots", () => {
  it("renders emerald dot when status is matched", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 50;
    const rows = [makeRow({ id: 50, label: "Netflix", nextOccurrence: "2026-05-12" })];
    const slotStatusById = { 50: "matched" as const };

    render(
      <UpcomingCharges
        rows={rows}
        excludedIds={new Set()}
        today={today}
        slotStatusById={slotStatusById}
      />,
    );

    const dot = screen.getByTestId("upcoming-status-dot");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toMatch(/bg-emerald-600/);
  });

  it("renders sky dot when status is upcoming", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 60;
    const rows = [makeRow({ id: 60, label: "Spotify", nextOccurrence: "2026-05-13" })];
    const slotStatusById = { 60: "upcoming" as const };

    render(
      <UpcomingCharges
        rows={rows}
        excludedIds={new Set()}
        today={today}
        slotStatusById={slotStatusById}
      />,
    );

    const dot = screen.getByTestId("upcoming-status-dot");
    expect(dot.className).toMatch(/bg-sky-500/);
  });

  it("renders rose dot when status is overdue", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 70;
    const rows = [makeRow({ id: 70, label: "HBO Max", nextOccurrence: "2026-05-11" })];
    const slotStatusById = { 70: "overdue" as const };

    render(
      <UpcomingCharges
        rows={rows}
        excludedIds={new Set()}
        today={today}
        slotStatusById={slotStatusById}
      />,
    );

    const dot = screen.getByTestId("upcoming-status-dot");
    expect(dot.className).toMatch(/bg-rose-600/);
  });

  it("does not render a dot when status is dismissed", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 80;
    const rows = [makeRow({ id: 80, label: "Apple TV", nextOccurrence: "2026-05-14" })];
    const slotStatusById = { 80: "dismissed" as const };

    render(
      <UpcomingCharges
        rows={rows}
        excludedIds={new Set()}
        today={today}
        slotStatusById={slotStatusById}
      />,
    );

    expect(screen.queryByTestId("upcoming-status-dot")).not.toBeInTheDocument();
  });

  it("does not render a dot when slotStatusById is not provided", () => {
    const today = new Date("2026-05-10T12:00:00");
    nextId = 90;
    const rows = [makeRow({ id: 90, label: "YouTube Premium", nextOccurrence: "2026-05-12" })];

    render(<UpcomingCharges rows={rows} excludedIds={new Set()} today={today} />);

    expect(screen.queryByTestId("upcoming-status-dot")).not.toBeInTheDocument();
  });
});
