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
  ConfidenceBadge: () => null,
  confidenceBand: () => null,
}));
vi.mock("@/components/transactions/needs-review-badge", () => ({
  NeedsReviewBadge: () => null,
}));

// Import AFTER mocks are registered.
import { TransactionTable } from "./transaction-table";
import { MoneyModeProvider } from "@/components/display/money-mode-provider";
import type { TxRow } from "@/lib/types";

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
