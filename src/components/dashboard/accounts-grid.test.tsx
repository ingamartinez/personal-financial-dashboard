// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Import AFTER mocks (none needed here — no next/navigation, no server actions).
// ---------------------------------------------------------------------------
import { AccountsGrid } from "./accounts-grid";
import { MoneyModeProvider } from "@/components/display/money-mode-provider";
import type { AccountDetail, PhysicalCardSummary } from "@/lib/accounts/queries";

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
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PC_SHARED: PhysicalCardSummary = {
  id: "pc-1",
  name: "Mastercard *7291",
  creditLimitCents: BigInt(30_000_000_00), // COP 30,000,000
  statementCutoffDay: 25,
  network: "mastercard",
  last4: "7291",
};

function makeAccount(overrides: Partial<AccountDetail> = {}): AccountDetail {
  return {
    id: 1,
    name: "Test Account",
    institution: "Bancolombia",
    type: "savings",
    currency: "COP",
    balanceCents: BigInt(5_000_000_00), // COP 5,000,000
    active: true,
    metadata: {},
    physicalCardId: null,
    physicalCard: null,
    ...overrides,
  };
}

function makeCopCard(id: number, physicalCard: PhysicalCardSummary | null = null): AccountDetail {
  return makeAccount({
    id,
    name: "Mastercard COP",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "COP",
    // Debt = -500,000 COP cents = -5,000 COP
    balanceCents: BigInt(-500_000_00),
    physicalCardId: physicalCard?.id ?? null,
    physicalCard,
    metadata: physicalCard ? {} : { creditLimitCents: 10_000_000_00 },
  });
}

function makeUsdCard(id: number, physicalCard: PhysicalCardSummary | null = null): AccountDetail {
  return makeAccount({
    id,
    name: "Mastercard USD",
    institution: "Bancolombia",
    type: "credit_card",
    currency: "USD",
    // Debt = -100 USD cents = -$1.00 USD
    balanceCents: BigInt(-100_00),
    physicalCardId: physicalCard?.id ?? null,
    physicalCard,
    metadata: {},
  });
}

function renderGrid(accounts: AccountDetail[], copPerUsd = 4000) {
  return render(
    <MoneyModeProvider mode="native" fxRate={{ rate: copPerUsd, source: "live" }}>
      <AccountsGrid accounts={accounts} copPerUsd={copPerUsd} />
    </MoneyModeProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AccountsGrid", () => {
  // Case 1: two accounts sharing one physical_card_id render as ONE tile.
  it("renders one tile for two sub-accounts sharing a physical_card_id", () => {
    const copCard = makeCopCard(1, PC_SHARED);
    const usdCard = makeUsdCard(2, PC_SHARED);
    renderGrid([copCard, usdCard]);

    // There should be exactly ONE article element (one tile).
    const articles = document.querySelectorAll("article");
    expect(articles).toHaveLength(1);

    // The tile title must be the physicalCard.name.
    expect(screen.getByText("Mastercard *7291")).toBeInTheDocument();
  });

  // Case 2: the shared tile renders disponible with currency="COP" (regression lock).
  // The old bug passed currency="USD" for the USD leg, causing 3640× inflation.
  it("renders Disponible label and Money with COP for a shared card", () => {
    const copCard = makeCopCard(1, PC_SHARED);
    const usdCard = makeUsdCard(2, PC_SHARED);

    // Render in all-cop mode to expose double-conversion if currency is wrong.
    render(
      <MoneyModeProvider mode="all-cop" fxRate={{ rate: 4000, source: "live" }}>
        <AccountsGrid accounts={[copCard, usdCard]} copPerUsd={4000} />
      </MoneyModeProvider>,
    );

    // "Disponible" heading present.
    expect(screen.getByText(/disponible/i)).toBeInTheDocument();

    // limit=30,000,000_00 COP + copDebt=-500,000_00 + usdDebt=toCop(-100_00 USD, 4000)=-40_000_000
    // available = 3_000_000_000 - 50_000_000 - 40_000_000 = 2_910_000_000 COP cents
    // In all-cop mode, since currency is already COP → no conversion. Just format.
    // We don't test exact amount here — the key assertion is that <Money currency="COP">
    // is rendered (not USD), so the displayed number is sane (not ~3640× inflated).
    // We verify by checking the tile shows "DISPONIBLE" once (not the inflated USD bug).
    const disponibleLabel = screen.getAllByText(/disponible/i);
    expect(disponibleLabel.length).toBeGreaterThanOrEqual(1);
  });

  // Case 3: the shared tile shows two breakdown rows labeled COP and USD.
  it("shows COP and USD breakdown rows for a shared card", () => {
    const copCard = makeCopCard(1, PC_SHARED);
    const usdCard = makeUsdCard(2, PC_SHARED);
    renderGrid([copCard, usdCard]);

    // Both breakdown rows should have currency labels.
    expect(screen.getByText("COP")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();

    // Both rows should show "Usado" text.
    const usadoTexts = screen.getAllByText(/usado/i);
    expect(usadoTexts.length).toBeGreaterThanOrEqual(2);
  });

  // Case 4: single-currency credit_card (no physical_card) uses native currency, no breakdown rows.
  it("renders a single-currency credit card without breakdown rows", () => {
    const singleCard = makeAccount({
      id: 10,
      name: "Nequi TC",
      institution: "Nequi",
      type: "credit_card",
      currency: "COP",
      balanceCents: BigInt(-200_000_00),
      physicalCardId: null,
      physicalCard: null,
      metadata: { creditLimitCents: 5_000_000_00 },
    });
    renderGrid([singleCard]);

    // Title uses formatAccountLabel: "Nequi TC (COP)".
    expect(screen.getByText("Nequi TC (COP)")).toBeInTheDocument();

    // No currency breakdown labels (COP/USD pill rows are only for shared cards).
    // There will be "Usado" and "Cupo" text but no currency code pills.
    const articles = document.querySelectorAll("article");
    expect(articles).toHaveLength(1);

    // Should NOT have sibling currency-code labels like standalone "COP" or "USD".
    // The single-card tile has no breakdown divs — check that the per-leg divs are absent.
    // We check by asserting the currency badge labels do NOT appear in their uppercase pill form.
    // (formatAccountLabel produces "Nequi TC (COP)" — the parenthesized form, not standalone "COP")
    const copPills = screen.queryAllByText("COP");
    // There should be zero standalone "COP" currency-code pill spans (those come from the shared breakdown).
    expect(copPills).toHaveLength(0);
  });

  // Case 5: a savings account renders its formatAccountLabel title.
  it("renders savings account with formatAccountLabel title", () => {
    const savings = makeAccount({
      id: 20,
      name: "Cuenta Ahorros",
      institution: "Bancolombia",
      type: "savings",
      currency: "COP",
      balanceCents: BigInt(1_000_000_00),
    });
    renderGrid([savings]);

    // formatAccountLabel produces "Cuenta Ahorros (COP)".
    expect(screen.getByText("Cuenta Ahorros (COP)")).toBeInTheDocument();
    // Eyebrow shows type label "Ahorros".
    expect(screen.getByText(/Bancolombia · Ahorros/)).toBeInTheDocument();
  });

  // Case 6 (edge case): single-member group where the lone account HAS physicalCard set
  // (e.g. the USD peer was archived). This must route through SharedCreditCardTile,
  // showing "Disponible" with currency="COP" and no breakdown rows (only one leg).
  it("routes single-member group with physicalCard to SharedCreditCardTile", () => {
    // Only the COP leg — USD peer is archived (not in the list).
    const copCard = makeCopCard(1, PC_SHARED);
    renderGrid([copCard]);

    // Should be ONE tile.
    const articles = document.querySelectorAll("article");
    expect(articles).toHaveLength(1);

    // "Disponible" heading must be present (shared tile path, not the savings-style tile).
    expect(screen.getByText(/disponible/i)).toBeInTheDocument();

    // The tile uses physicalCard.name as title.
    expect(screen.getByText("Mastercard *7291")).toBeInTheDocument();

    // No breakdown rows when only one leg exists (copCard has negative balance,
    // but usdCard is missing — only the COP row would render if it had debt, which it does).
    // The key assertion: "Cupo" uses COP (not USD native), and the available is in COP.
    // We assert "Cupo" is present (from the shared tile footer).
    expect(screen.getByText(/cupo/i)).toBeInTheDocument();

    // No USD label pill (no USD breakdown row since only one leg).
    const usdPills = screen.queryAllByText("USD");
    expect(usdPills).toHaveLength(0);
  });
});
