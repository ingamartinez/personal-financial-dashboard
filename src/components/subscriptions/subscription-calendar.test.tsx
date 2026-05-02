// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SubscriptionCalendar, UpcomingCharges } from "./subscription-calendar";
import type { SubscriptionRow } from "@/app/(app)/subscriptions/queries";

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
  vi.useRealTimers();
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
// UpcomingCharges tests
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
});

// ---------------------------------------------------------------------------
// SubscriptionCalendar tests
// ---------------------------------------------------------------------------

describe("SubscriptionCalendar", () => {
  it("renders the current month calendar with section title", () => {
    nextId = 100;
    const rows = [makeRow({ nextOccurrence: "2026-05-15" })];
    render(<SubscriptionCalendar rows={rows} excludedIds={new Set()} />);

    // Calendar title should appear.
    expect(screen.getByText("Calendario del mes")).toBeInTheDocument();
  });

  it("days with charges get rdp-day-charge class via modifiersClassNames", () => {
    nextId = 200;
    // Set up a row that charges on day 10 of the current month (May 2026).
    const rows = [makeRow({ id: 200, nextOccurrence: "2026-05-10" })];
    render(<SubscriptionCalendar rows={rows} excludedIds={new Set()} />);

    // React-day-picker applies modifiersClassNames to the day cell.
    // The charge modifier class is rdp-day-charge (part of rdp-day-charge-top/medianas/pequeñas).
    const chargeDays = document.querySelectorAll(".rdp-day-charge");
    expect(chargeDays.length).toBeGreaterThan(0);
  });

  it("excluded subs do not produce charge-day markers", () => {
    nextId = 400;
    const rows = [
      makeRow({ id: 400, label: "Netflix", nextOccurrence: "2026-05-20" }),
      makeRow({ id: 401, label: "Spotify", nextOccurrence: "2026-05-20" }),
    ];
    // Exclude both — no charge class applied.
    render(<SubscriptionCalendar rows={rows} excludedIds={new Set([400, 401])} />);

    const chargeDays = document.querySelectorAll(".rdp-day-charge");
    expect(chargeDays.length).toBe(0);
  });

  it("only active (non-excluded) subs appear in charge day markers", () => {
    nextId = 500;
    const rows = [
      makeRow({ id: 500, label: "Netflix", nextOccurrence: "2026-05-20" }),
      makeRow({ id: 501, label: "Spotify", nextOccurrence: "2026-05-15" }),
    ];
    // Exclude Netflix — only Spotify's day should have a charge marker.
    render(<SubscriptionCalendar rows={rows} excludedIds={new Set([500])} />);

    // Exactly 1 charge day visible (day 15 for Spotify).
    const chargeDays = document.querySelectorAll(".rdp-day-charge");
    expect(chargeDays.length).toBe(1);
  });

  it("multi-charge days: both subs on same day produce 1 charge marker", () => {
    nextId = 600;
    const rows = [
      makeRow({ id: 600, label: "Netflix", nextOccurrence: "2026-05-20" }),
      makeRow({ id: 601, label: "Spotify", nextOccurrence: "2026-05-20" }),
    ];
    render(<SubscriptionCalendar rows={rows} excludedIds={new Set()} />);

    // 2 subs on the same day → still 1 day cell gets the charge class.
    const chargeDays = document.querySelectorAll(".rdp-day-charge");
    expect(chargeDays.length).toBe(1);
  });
});
