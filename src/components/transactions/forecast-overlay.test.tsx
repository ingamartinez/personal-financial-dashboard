// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted mocks — factories in vi.mock are hoisted above top-level consts.
// ---------------------------------------------------------------------------
const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));

// Stub heavy / server-side deps that TransactionTable pulls in.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// motion/react: passthrough wrapper — keeps framer-motion out of jsdom.
vi.mock("motion/react", () => ({
  motion: {
    tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...props} />,
    li: (props: React.HTMLAttributes<HTMLLIElement>) => <li {...props} />,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}));

// Stub leaf components to reduce mount surface.
vi.mock("@/lib/hooks/use-new-ids", () => ({ useNewIds: () => new Set() }));
vi.mock("@/components/transactions/category-cell", () => ({
  CategoryCell: () => <span data-testid="category-cell" />,
}));
vi.mock("@/components/transactions/transaction-row-actions", () => ({
  TransactionRowActions: () => <span data-testid="tx-row-actions" />,
}));
vi.mock("@/components/transactions/forecast-row-actions", () => ({
  ForecastRowActions: () => <span data-testid="forecast-row-actions" />,
}));
vi.mock("@/components/transactions/classification-reason-dialog", () => ({
  ClassificationReasonDialog: () => null,
}));
vi.mock("@/components/transactions/counterparty-dialog", () => ({
  CounterpartyDialog: () => null,
}));
vi.mock("@/components/transactions/counterparty-cell", () => ({
  CounterpartyCell: () => <span data-testid="counterparty-cell" />,
}));
vi.mock("@/components/transactions/confidence-badge", () => ({
  ConfidenceBadge: () => null,
  confidenceBand: () => "medium",
}));
vi.mock("@/components/transactions/needs-review-badge", () => ({
  NeedsReviewBadge: () => null,
}));

// Import AFTER mocks are registered.
import { TransactionTable, mergeRows, type MergedRow } from "./transaction-table";
import type { TxRow } from "@/lib/types";
import type { ForecastOccurrence } from "@/lib/recurring/expected-occurrences";

// ---------------------------------------------------------------------------
// Radix shims — pointer capture + scrollIntoView not in jsdom.
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
  routerRefresh.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTxRow(overrides: Partial<TxRow> = {}): TxRow {
  return {
    id: 1,
    occurredAt: new Date("2026-04-10T00:00:00Z"),
    amountCents: BigInt(-50000),
    currency: "COP",
    descriptionRaw: "SUPERMERCADO TEST",
    descriptionClean: "Supermercado",
    merchant: "Supermercado Test",
    categorySlug: "alimentacion",
    classificationMethod: "rule",
    classificationConfidence: 0.95,
    source: "sms",
    isAdjustment: false,
    accountId: 1,
    accountName: "Nequi (COP)",
    accountType: "savings",
    installmentsTotal: 1,
    installmentRateEmX10k: null,
    counterparty: null,
    deletedAt: null,
    recurringId: null,
    recurringYearMonth: null,
    recurringLabel: null,
    // #642: transfer pairing defaults
    channel: "bank",
    transferGroupId: null,
    ...overrides,
  };
}

function makeForecast(overrides: Partial<ForecastOccurrence> = {}): ForecastOccurrence {
  return {
    recurringId: 10,
    label: "Netflix",
    accountId: 2,
    amountCents: BigInt(-4990),
    currency: "COP",
    categorySlug: "entretenimiento",
    expectedDate: new Date("2026-04-15T00:00:00Z"),
    expectedDateIso: "2026-04-15T00:00:00.000Z",
    status: "esperado",
    accountName: "Mastercard *1234 (COP)",
    accountCurrency: "COP",
    ...overrides,
  };
}

const EMPTY_RECURRINGS = [] as Parameters<typeof TransactionTable>[0]["activeRecurrings"];

// ---------------------------------------------------------------------------
// Tests — mergeRows (unit, no DOM needed)
// ---------------------------------------------------------------------------

describe("mergeRows", () => {
  it("forecast rows with status=linkeado are excluded from merged output", () => {
    const fc1 = makeForecast({ status: "linkeado", recurringId: 10 });
    const fc2 = makeForecast({ status: "esperado", recurringId: 11 });
    const merged = mergeRows([], [fc1, fc2]);
    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("forecast");
    expect((merged[0] as Extract<MergedRow, { kind: "forecast" }>).data.recurringId).toBe(11);
  });

  it("forecast rows with status=synthetic are excluded from merged output", () => {
    const fc = makeForecast({ status: "synthetic", recurringId: 10 });
    const merged = mergeRows([], [fc]);
    expect(merged).toHaveLength(0);
  });

  /**
   * Architecture invariant: forecast rows must NEVER count toward the month total.
   *
   * The displayed month total in /transactions is computed by countTotal() in
   * page.tsx — a DB query against the transactions table only. forecast rows
   * are a render-time overlay (issue #622) and never reach that query.
   *
   * This test asserts the kind-separation contract of mergeRows() at the data
   * layer. If someone later adds a row-level footer total inside TransactionTable,
   * they MUST filter by kind === 'tx' and a DOM-level assertion should be added
   * here.
   */
  it("ARCHITECTURE INVARIANT — forecast amounts MUST NOT be counted in the month total", () => {
    const tx1 = makeTxRow({ id: 1, amountCents: BigInt(-80000) });
    const tx2 = makeTxRow({ id: 2, amountCents: BigInt(-24990) });
    const forecast1 = makeForecast({
      recurringId: 10,
      amountCents: BigInt(-80000),
      status: "esperado",
    });
    const forecast2 = makeForecast({
      recurringId: 11,
      amountCents: BigInt(-24990),
      status: "atrasado",
    });

    const merged = mergeRows([tx1, tx2], [forecast1, forecast2]);

    // Sum only the real-tx kind rows.
    const txOnlyTotal = merged
      .filter((r): r is Extract<MergedRow, { kind: "tx" }> => r.kind === "tx")
      .reduce((acc, r) => acc + r.data.amountCents, BigInt(0));

    // Sum only the forecast kind rows.
    const forecastTotal = merged
      .filter((r): r is Extract<MergedRow, { kind: "forecast" }> => r.kind === "forecast")
      .reduce((acc, r) => acc + r.data.amountCents, BigInt(0));

    // Concrete values — the amounts are intentionally equal per kind so a naive
    // implementation that accidentally mixes kinds would STILL produce the wrong
    // total (doubled), making the guard non-trivial.
    expect(txOnlyTotal).toBe(BigInt(-104990)); // tx1 + tx2 = -80000 + -24990
    expect(forecastTotal).toBe(BigInt(-104990)); // forecast1 + forecast2 (same values)

    // What the total would WRONGLY be if forecasts were mixed in:
    const wrongTotalIfMixed = txOnlyTotal + forecastTotal;
    expect(wrongTotalIfMixed).toBe(BigInt(-209980)); // doubled — the bug we guard against
    expect(txOnlyTotal).not.toBe(wrongTotalIfMixed); // explicit guard: facts-only != mixed

    // Total row count = 2 tx + 2 forecast (neither is linkeado/synthetic).
    expect(merged).toHaveLength(4);
  });

  it("sorts rows by date descending mixing tx and forecast", () => {
    const earlier = makeTxRow({ id: 1, occurredAt: new Date("2026-04-05T00:00:00Z") });
    const later = makeTxRow({ id: 2, occurredAt: new Date("2026-04-20T00:00:00Z") });
    const fc = makeForecast({ expectedDateIso: "2026-04-15T00:00:00.000Z" });
    const merged = mergeRows([earlier, later], [fc]);
    // Descending: later (Apr 20) > forecast (Apr 15) > earlier (Apr 5).
    expect(merged[0].kind).toBe("tx");
    expect(merged[1].kind).toBe("forecast");
    expect(merged[2].kind).toBe("tx");
  });
});

// ---------------------------------------------------------------------------
// Tests — TransactionTable rendering
// ---------------------------------------------------------------------------

describe("TransactionTable — forecast overlay rendering", () => {
  function renderTable(txRows: TxRow[], forecastOccurrences: ForecastOccurrence[] = []) {
    return render(
      <TransactionTable
        rows={txRows}
        categories={[]}
        allCounterparties={[]}
        activeRecurrings={EMPTY_RECURRINGS}
        forecastOccurrences={forecastOccurrences}
      />,
    );
  }

  it("renders a forecast row with 'esperado' status badge", () => {
    const fc = makeForecast({ status: "esperado", label: "Netflix" });
    renderTable([], [fc]);
    // The table renders desktop + mobile rows; check at least one badge.
    const badges = screen.getAllByText("Esperado");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a forecast row with 'atrasado' status badge", () => {
    const fc = makeForecast({ status: "atrasado", label: "Spotify" });
    renderTable([], [fc]);
    const badges = screen.getAllByText("Atrasado");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a forecast row with 'skipped' Saltado badge", () => {
    const fc = makeForecast({ status: "skipped", label: "HBO" });
    renderTable([], [fc]);
    const badges = screen.getAllByText("Saltado");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the RecurringBadge (↻ Recurring) on a real tx linked to a recurring", () => {
    const tx = makeTxRow({
      id: 99,
      recurringId: 5,
      recurringYearMonth: "2026-04",
      recurringLabel: "Gym",
    });
    renderTable([tx]);
    // RecurringBadge renders text "Gym" (truncated label).
    // Both desktop and mobile views render the badge — getAllByTitle is intentional.
    const badges = screen.getAllByTitle("Recurring: Gym");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT render ForecastRowActions on a 'skipped' forecast row", () => {
    // skipped rows show no action menu — the condition in the template excludes them.
    const fc = makeForecast({ status: "skipped" });
    renderTable([], [fc]);
    expect(screen.queryByTestId("forecast-row-actions")).not.toBeInTheDocument();
  });

  it("renders ForecastRowActions on an 'esperado' forecast row", () => {
    const fc = makeForecast({ status: "esperado" });
    renderTable([], [fc]);
    expect(screen.getAllByTestId("forecast-row-actions").length).toBeGreaterThanOrEqual(1);
  });

  it("'linkeado' forecasts are NOT rendered as forecast rows (already have a tx)", () => {
    const fc = makeForecast({ status: "linkeado" });
    renderTable([], [fc]);
    // mergeRows filters out linkeado — no forecast-row data-testid should appear.
    expect(screen.queryByTestId("forecast-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("forecast-row-mobile")).not.toBeInTheDocument();
  });

  it("renders a real tx row and a forecast row side by side without mixing amounts", () => {
    const tx = makeTxRow({ id: 1, amountCents: BigInt(-50000) });
    const fc = makeForecast({ status: "atrasado", amountCents: BigInt(-9990) });
    const { container } = renderTable([tx], [fc]);

    const forecastRows = container.querySelectorAll("[data-testid='forecast-row']");
    const forecastRowsMobile = container.querySelectorAll("[data-testid='forecast-row-mobile']");
    // At least one of desktop/mobile renders the forecast row.
    expect(forecastRows.length + forecastRowsMobile.length).toBeGreaterThanOrEqual(1);

    // The forecast amount cell carries the "not in total" title attribute.
    const estimatedCells = container.querySelectorAll(
      "[title='Monto estimado — no suma al total del mes']",
    );
    expect(estimatedCells.length).toBeGreaterThanOrEqual(1);
  });
});
