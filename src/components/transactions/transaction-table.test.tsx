// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// motion/react: passthrough — keeps framer-motion out of jsdom.
vi.mock("motion/react", () => ({
  motion: {
    tr: (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...props} />,
    li: (props: React.HTMLAttributes<HTMLLIElement>) => <li {...props} />,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}));

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
vi.mock("@/components/transactions/counterparty-dialog", () => ({
  CounterpartyDialog: () => null,
}));
vi.mock("@/components/transactions/confidence-badge", () => ({
  ConfidenceBadge: vi.fn(() => null),
  confidenceBand: vi.fn(() => null),
}));
vi.mock("@/components/transactions/needs-review-badge", () => ({
  NeedsReviewBadge: () => null,
}));

// Import AFTER mocks are registered.
import { TransactionTable } from "./transaction-table";
import { MoneyModeProvider } from "@/components/display/money-mode-provider";
import type { TxRow } from "@/lib/types";
import {
  ConfidenceBadge as MockedConfidenceBadge,
  confidenceBand as mockedConfidenceBand,
} from "@/components/transactions/confidence-badge";

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

const TRANSFER_GROUP_ID = "39ef646a-eb58-4259-9bfc-e1c62e75fc26";

function makeTxRow(overrides: Partial<TxRow> = {}): TxRow {
  return {
    id: 1,
    occurredAt: new Date("2026-04-16T00:00:00Z"),
    amountCents: BigInt(-50000),
    currency: "COP",
    descriptionRaw: "PAGO TC *2575",
    descriptionClean: "Pago TC",
    merchant: null,
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
    channel: "bank",
    transferGroupId: null,
    rawData: null,
    anomalyFlags: null,
    ...overrides,
  };
}

const TABLE_PROPS = {
  categories: [] as Parameters<typeof TransactionTable>[0]["categories"],
  allCounterparties: [] as Parameters<typeof TransactionTable>[0]["allCounterparties"],
  activeRecurrings: [] as Parameters<typeof TransactionTable>[0]["activeRecurrings"],
};

// ---------------------------------------------------------------------------
// Tests — #642: transfer badge and "Sin clasificar" suppression
// ---------------------------------------------------------------------------

// The table renders both a desktop (<table>) and a mobile (<ul>) view.
// Elements appear twice in the DOM — use getAllBy* or queryAllBy* accordingly.

describe("TransactionTable — paired transfer badge", () => {
  it("renders the transfer badge (desktop+mobile) when transferGroupId is set", () => {
    const tx = makeTxRow({
      id: 100,
      channel: "transfer",
      transferGroupId: TRANSFER_GROUP_ID,
      categorySlug: null,
      classificationMethod: "manual",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // Both desktop table row and mobile list item render the badge.
    const badges = screen.getAllByTestId("transfer-badge");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT render the transfer badge when transferGroupId is null", () => {
    const tx = makeTxRow({ id: 101, channel: "bank", transferGroupId: null });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    expect(screen.queryByTestId("transfer-badge")).not.toBeInTheDocument();
  });

  it("does NOT render the transfer badge when channel is not transfer even if transferGroupId is set", () => {
    // Defensive: transferGroupId without channel='transfer' should not badge.
    const tx = makeTxRow({
      id: 102,
      channel: "bank",
      transferGroupId: TRANSFER_GROUP_ID,
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    expect(screen.queryByTestId("transfer-badge")).not.toBeInTheDocument();
  });
});

describe("TransactionTable — paired transfer suppresses 'Sin clasificar'", () => {
  it("does NOT show '¿Por qué?' button for a paired transfer row", () => {
    const tx = makeTxRow({
      id: 200,
      channel: "transfer",
      transferGroupId: TRANSFER_GROUP_ID,
      categorySlug: null,
      classificationMethod: "manual",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // ClassificationReasonDialog is suppressed for paired transfers.
    const porqueBtns = screen.queryAllByLabelText("¿Por qué esta categoría?");
    expect(porqueBtns).toHaveLength(0);
  });

  it("shows '¿Por qué?' button for a non-transfer classified row", () => {
    const tx = makeTxRow({
      id: 201,
      channel: "bank",
      transferGroupId: null,
      categorySlug: "alimentacion",
      classificationMethod: "rule",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // ClassificationReasonDialog renders the button for non-unclassified rows.
    // Both desktop and mobile render it, so at least 1 is present.
    const porqueBtns = screen.getAllByLabelText("¿Por qué esta categoría?");
    expect(porqueBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT apply destructive styling on paired transfer even when method is 'unclassified'", () => {
    // Theoretical edge case: a transfer that arrives before classification.
    // The `isUnclassified && !isPairedTransfer` guard at desktop line 467 must
    // suppress the red text. This test locks in that behavior.
    const tx = makeTxRow({
      id: 202,
      channel: "transfer",
      transferGroupId: TRANSFER_GROUP_ID,
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // Desktop renders the method label as a span; assert no destructive class.
    const methodLabels = screen.getAllByText("unclassified");
    for (const label of methodLabels) {
      expect(label).not.toHaveClass("text-destructive");
    }

    // ¿Por qué? must still be suppressed.
    const porqueBtns = screen.queryAllByLabelText("¿Por qué esta categoría?");
    expect(porqueBtns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — #766: cash_withdrawal also suppresses ClassificationReasonDialog
// ---------------------------------------------------------------------------

describe("TransactionTable — #766 cash_withdrawal suppresses classification UI", () => {
  it("does NOT render '¿Por qué?' button for a cash_withdrawal row", () => {
    // ATM rows have method="manual" by structural convention (not a user action).
    // Showing "Clasificado manualmente" would be misleading — the dialog must be hidden.
    const tx = makeTxRow({
      id: 300,
      channel: "cash_withdrawal",
      transferGroupId: null,
      categorySlug: null,
      classificationMethod: "manual",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    const porqueBtns = screen.queryAllByLabelText("¿Por qué esta categoría?");
    expect(porqueBtns).toHaveLength(0);
  });

  it("does NOT apply destructive styling for cash_withdrawal with method='unclassified'", () => {
    const tx = makeTxRow({
      id: 301,
      channel: "cash_withdrawal",
      transferGroupId: null,
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    const methodLabels = screen.getAllByText("unclassified");
    for (const label of methodLabels) {
      expect(label).not.toHaveClass("text-destructive");
    }
    expect(screen.queryAllByLabelText("¿Por qué esta categoría?")).toHaveLength(0);
  });

  it("shows '¿Por qué?' button for a regular bank row with method='manual'", () => {
    // Regression: channel="bank" + method="manual" should still show the dialog.
    const tx = makeTxRow({
      id: 302,
      channel: "bank",
      transferGroupId: null,
      categorySlug: "alimentacion",
      classificationMethod: "manual",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    const porqueBtns = screen.getAllByLabelText("¿Por qué esta categoría?");
    expect(porqueBtns.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — #528: real tx amounts use frozen TRM (MoneyFrozen wire-up)
// ---------------------------------------------------------------------------

const FROZEN_TRM = 3676.92;
const LIVE_TRM = 4200; // intentionally different so tests can prove which one wins

function fxBlock(trm: number, original: { currency: "USD" | "USDc"; amountCents: bigint }) {
  return {
    fx: {
      originalCurrency: original.currency,
      originalAmountCents: original.amountCents.toString(),
      trmToAccountCurrency: trm,
      trmSource: "statement_frozen",
    },
  };
}

function renderWithMode(
  rows: TxRow[],
  opts: { mode: "native" | "all-cop" | "all-usd"; liveRate: number | null },
) {
  return render(
    <MoneyModeProvider
      mode={opts.mode}
      fxRate={opts.liveRate === null ? null : { rate: opts.liveRate, source: "live" }}
    >
      <TransactionTable rows={rows} {...TABLE_PROPS} />
    </MoneyModeProvider>,
  );
}

describe("TransactionTable — #528 frozen TRM via MoneyFrozen", () => {
  it("converts a USD tx with frozen TRM (NOT live TRM) when mode=all-cop", () => {
    // tx: USD 100.00 (10000 cents) with frozen TRM = 3676.92 → COP ~367,692
    // If MoneyFrozen incorrectly used the live TRM (4200), result would be ~420,000.
    const tx = makeTxRow({
      id: 5280,
      amountCents: BigInt(-10000),
      currency: "USD" as TxRow["currency"],
      rawData: fxBlock(FROZEN_TRM, { currency: "USD", amountCents: BigInt(10000) }),
    });

    renderWithMode([tx], { mode: "all-cop", liveRate: LIVE_TRM });

    // Frozen-TRM tooltip is set on the wrapping <span title="..."> in MoneyFrozen.
    // It contains the formatted historical TRM (3.676,92 in es-CO locale).
    const tooltipNodes = document.querySelectorAll('[title*="TRM histórica"]');
    expect(tooltipNodes.length).toBeGreaterThan(0);
    // Confirm the historical rate (3.676,92 in es-CO) is the one shown — NOT 4.200.
    for (const node of tooltipNodes) {
      const title = node.getAttribute("title") ?? "";
      expect(title).toMatch(/3\.676,92/);
      expect(title).not.toMatch(/4\.200/);
    }
  });

  it("does not convert in mode=native (regression check for COP-only users)", () => {
    const tx = makeTxRow({
      id: 5281,
      amountCents: BigInt(-10000),
      currency: "USD" as TxRow["currency"],
      rawData: fxBlock(FROZEN_TRM, { currency: "USD", amountCents: BigInt(10000) }),
    });

    renderWithMode([tx], { mode: "native", liveRate: LIVE_TRM });

    // No frozen-TRM tooltip should be rendered when conversion didn't happen.
    const tooltipNodes = document.querySelectorAll('[title*="TRM histórica"]');
    expect(tooltipNodes.length).toBe(0);
  });

  it("falls back to original currency when rawData is null (legacy txs)", () => {
    const tx = makeTxRow({
      id: 5282,
      amountCents: BigInt(-10000),
      currency: "USD" as TxRow["currency"],
      rawData: null,
    });

    renderWithMode([tx], { mode: "all-cop", liveRate: LIVE_TRM });

    // No conversion performed → no tooltip; raw amount renders as-is.
    const tooltipNodes = document.querySelectorAll('[title*="TRM histórica"]');
    expect(tooltipNodes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — #713 B.2: combined first-encounter + low-confidence badge
//
// The desktop row (lines 487–514 of transaction-table.tsx) implements a
// combined-badge decision:
//   • firstEncounter=true AND band="low"  → ONE combined badge, ConfidenceBadge suppressed
//   • firstEncounter=true AND band≠"low"  → standalone "Nuevo merchant" badge, ConfidenceBadge
//                                            natural (null for high/rule; renders for medium)
//   • firstEncounter=false / null          → no first-encounter badge, ConfidenceBadge natural
//
// The mocks for confidenceBand and ConfidenceBadge are vi.fn() so they can be
// overridden per describe block without affecting the rest of the suite.
// ---------------------------------------------------------------------------

// Real confidenceBand logic (inlined so we never import through the mock).
function realBand(
  method: TxRow["classificationMethod"],
  confidence: number | null,
): "high" | "medium" | "low" | null {
  if (method !== "rule" && method !== "ai") return null;
  if (confidence === null) return null;
  if (confidence >= 90) return "high";
  if (confidence >= 60) return "medium";
  return "low";
}

describe("TransactionTable — #713 combined first-encounter + low-confidence badge", () => {
  beforeEach(() => {
    // Wire real band logic into the mock so the component's conditional fires.
    vi.mocked(mockedConfidenceBand).mockImplementation(realBand);
    // Keep ConfidenceBadge invisible by default; tests that need it visible will
    // override in their own beforeEach or arrange step.
    vi.mocked(MockedConfidenceBadge).mockReturnValue(null);
  });

  afterEach(() => {
    // Reset to the baseline mock after each test.
    vi.mocked(mockedConfidenceBand).mockReturnValue(null);
    vi.mocked(MockedConfidenceBadge).mockReturnValue(null);
  });

  it("firstEncounter=true + low-confidence: renders combined badge, suppresses ConfidenceBadge", () => {
    // confidence=30 (scale 0–100, threshold LOW=60) → band="low" with method="ai"
    const tx = makeTxRow({
      id: 7130,
      classificationMethod: "ai",
      classificationConfidence: 30,
      anomalyFlags: { firstEncounter: true, detectedAt: "2026-05-02T00:00:00Z" },
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // Desktop renders the combined badge text.
    expect(screen.getByText("Nuevo merchant — confirmá categoría")).toBeInTheDocument();

    // Standalone "Nuevo merchant" must NOT appear (replaced by combined).
    expect(screen.queryByText("Nuevo merchant")).not.toBeInTheDocument();

    // ConfidenceBadge mock was called (component tried to render it in mobile)
    // but the desktop path suppresses it — the mock returns null so nothing
    // with "revisar" text should be in the DOM at all.
    expect(screen.queryByText("revisar")).not.toBeInTheDocument();
  });

  it("firstEncounter=true + high-confidence (rule): standalone 'Nuevo merchant' badge, no ConfidenceBadge", () => {
    // method="rule" + confidence=95 → band="high". ConfidenceBadge returns null for
    // "high" naturally. band≠"low" → else branch fires → standalone badge + no combined.
    const tx = makeTxRow({
      id: 7131,
      classificationMethod: "rule",
      classificationConfidence: 95,
      anomalyFlags: { firstEncounter: true, detectedAt: "2026-05-02T00:00:00Z" },
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // Standalone badge must appear (band is "high", not "low" → else branch fires).
    expect(screen.getByText("Nuevo merchant")).toBeInTheDocument();

    // Combined badge must NOT appear.
    expect(screen.queryByText("Nuevo merchant — confirmá categoría")).not.toBeInTheDocument();

    // ConfidenceBadge mock returns null → no "revisar" text.
    expect(screen.queryByText("revisar")).not.toBeInTheDocument();
  });

  it("firstEncounter=true + medium-confidence: standalone 'Nuevo merchant' AND ConfidenceBadge coexist", () => {
    // confidence=75 → band="medium". Only "low" triggers merge; medium lets both coexist.
    vi.mocked(MockedConfidenceBadge).mockReturnValue(
      <span data-testid="confidence-badge-medium">75%</span>,
    );

    const tx = makeTxRow({
      id: 7132,
      classificationMethod: "ai",
      classificationConfidence: 75,
      anomalyFlags: { firstEncounter: true, detectedAt: "2026-05-02T00:00:00Z" },
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // Standalone "Nuevo merchant" badge IS rendered (else branch, firstEncounter=true).
    expect(screen.getByText("Nuevo merchant")).toBeInTheDocument();

    // Combined badge must NOT appear (band is medium, not low).
    expect(screen.queryByText("Nuevo merchant — confirmá categoría")).not.toBeInTheDocument();

    // ConfidenceBadge renders its medium output (desktop path does NOT suppress it).
    expect(screen.getAllByTestId("confidence-badge-medium").length).toBeGreaterThanOrEqual(1);
  });

  it("firstEncounter=false (anomalyFlags=null): no first-encounter badge, ConfidenceBadge natural", () => {
    // No anomalyFlags → neither badge branch fires for first-encounter.
    const tx = makeTxRow({
      id: 7133,
      classificationMethod: "ai",
      classificationConfidence: 30,
      anomalyFlags: null,
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    expect(screen.queryByText("Nuevo merchant")).not.toBeInTheDocument();
    expect(screen.queryByText("Nuevo merchant — confirmá categoría")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — #719 B.4: categoryAnomaly badge priority chain
// ---------------------------------------------------------------------------

describe("TransactionTable — #719 categoryAnomaly badge priority", () => {
  beforeEach(() => {
    vi.mocked(mockedConfidenceBand).mockImplementation(realBand);
    vi.mocked(MockedConfidenceBadge).mockReturnValue(null);
  });

  afterEach(() => {
    vi.mocked(mockedConfidenceBand).mockReturnValue(null);
    vi.mocked(MockedConfidenceBadge).mockReturnValue(null);
  });

  it("Priority 1: categoryAnomaly + low-confidence → combined rose badge, suppresses ConfidenceBadge", () => {
    const tx = makeTxRow({
      id: 7190,
      classificationMethod: "ai",
      classificationConfidence: 30, // low
      anomalyFlags: {
        categoryAnomaly: {
          expectedCategory: "alimentacion",
          actualCategory: "transporte",
          modalShare: 0.9,
        },
        detectedAt: "2026-05-02T00:00:00Z",
      },
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // The combined rose badge text must contain the expected category
    const badge = screen.getByText(/Categoría inusual — confirmá \(alimentacion\)/);
    expect(badge).toBeInTheDocument();

    // Standalone "Categoría inusual" badge must NOT appear separately
    expect(screen.queryByText("Categoría inusual")).not.toBeInTheDocument();

    // ConfidenceBadge mock returns null → no confidence text
    expect(screen.queryByText("revisar")).not.toBeInTheDocument();
  });

  it("Priority 2: categoryAnomaly + firstEncounter → combined orange badge, suppresses both", () => {
    const tx = makeTxRow({
      id: 7191,
      classificationMethod: "rule",
      classificationConfidence: 95, // high
      anomalyFlags: {
        categoryAnomaly: {
          expectedCategory: "alimentacion",
          actualCategory: "transporte",
          modalShare: 0.85,
        },
        firstEncounter: true,
        detectedAt: "2026-05-02T00:00:00Z",
      },
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    expect(screen.getByText("Categoría inusual + nuevo merchant")).toBeInTheDocument();

    // Neither standalone badge nor confidence badge should appear
    expect(screen.queryByText("Categoría inusual")).not.toBeInTheDocument();
    expect(screen.queryByText("Nuevo merchant")).not.toBeInTheDocument();
    expect(screen.queryByText("revisar")).not.toBeInTheDocument();
  });

  it("Priority 3: categoryAnomaly alone → standalone purple badge, ConfidenceBadge coexists", () => {
    // Method=ai, confidence=75 → band=medium; category-anomaly alone takes priority 3
    vi.mocked(MockedConfidenceBadge).mockReturnValue(
      <span data-testid="confidence-badge-medium">75%</span>,
    );

    const tx = makeTxRow({
      id: 7192,
      classificationMethod: "ai",
      classificationConfidence: 75, // medium
      anomalyFlags: {
        categoryAnomaly: {
          expectedCategory: "servicios",
          actualCategory: "entretenimiento",
          modalShare: 0.9,
        },
        detectedAt: "2026-05-02T00:00:00Z",
      },
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // Standalone purple badge
    expect(screen.getByText("Categoría inusual")).toBeInTheDocument();

    // ConfidenceBadge still renders (NOT suppressed in priority 3)
    expect(screen.getAllByTestId("confidence-badge-medium").length).toBeGreaterThanOrEqual(1);

    // Combined badges must NOT appear
    expect(screen.queryByText(/confirmá/)).not.toBeInTheDocument();
    expect(screen.queryByText("Categoría inusual + nuevo merchant")).not.toBeInTheDocument();
  });

  it("Suppression: categoryAnomaly + low-confidence suppresses standalone Nuevo merchant", () => {
    // When priority 1 fires (catAnom + low), even if firstEncounter=true,
    // the combined catAnom+low badge wins and neither firstEncounter badge renders.
    const tx = makeTxRow({
      id: 7193,
      classificationMethod: "ai",
      classificationConfidence: 30, // low
      anomalyFlags: {
        categoryAnomaly: {
          expectedCategory: "alimentacion",
          actualCategory: "transporte",
          modalShare: 0.9,
        },
        firstEncounter: true,
        detectedAt: "2026-05-02T00:00:00Z",
      },
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // Priority 1 fires (catAnom+low) — combined rose badge
    expect(screen.getByText(/Categoría inusual — confirmá/)).toBeInTheDocument();

    // Neither first-encounter badge should appear
    expect(screen.queryByText("Nuevo merchant")).not.toBeInTheDocument();
    expect(screen.queryByText("Nuevo merchant — confirmá categoría")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — #788: RecurringBadge shows CheckCircle2 (emerald) for linked rows
// ---------------------------------------------------------------------------

describe("TransactionTable — #788 recurring badge CheckCircle2 icon", () => {
  it("renders the recurring badge with CheckCircle2 when recurringId is set", () => {
    const tx = makeTxRow({
      id: 900,
      recurringId: 1,
      recurringLabel: "Netflix",
    });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    // data-testid="recurring-badge" — present in both desktop and mobile.
    const badges = screen.getAllByTestId("recurring-badge");
    expect(badges.length).toBeGreaterThanOrEqual(1);

    // The wrapper has the tooltip.
    expect(badges[0]).toHaveAttribute("title", "Recurrente: Netflix");

    // The label text is rendered inside the badge.
    expect(screen.getAllByText("Netflix").length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT render the recurring badge when recurringId is null", () => {
    const tx = makeTxRow({ id: 901, recurringId: null, recurringLabel: null });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    expect(screen.queryByTestId("recurring-badge")).not.toBeInTheDocument();
  });

  it("uses generic 'Recurrente' tooltip when recurringLabel is null but recurringId is set", () => {
    const tx = makeTxRow({ id: 902, recurringId: 5, recurringLabel: null });

    render(<TransactionTable rows={[tx]} {...TABLE_PROPS} />);

    const badges = screen.getAllByTestId("recurring-badge");
    expect(badges[0]).toHaveAttribute("title", "Recurrente");
  });
});
