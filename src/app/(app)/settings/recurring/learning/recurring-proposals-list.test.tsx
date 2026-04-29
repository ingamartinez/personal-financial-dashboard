// @vitest-environment jsdom
// #633: Component tests for RecurringProposalsList.

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoisted mocks — actions are the only external deps for the client component.
// ---------------------------------------------------------------------------
const { acceptProposal, rejectProposal } = vi.hoisted(() => ({
  acceptProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));

vi.mock("./actions", () => ({ acceptProposal, rejectProposal }));

// Import AFTER mocks.
import { RecurringProposalsList } from "./recurring-proposals-list";

// ---------------------------------------------------------------------------
// Radix shims (safe even if not strictly needed — belt-and-suspenders).
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
  acceptProposal.mockReset();
  rejectProposal.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const amountUpdateProposal = {
  id: 1,
  recurringId: 10,
  label: "Netflix",
  accountLabel: "Bancolombia COP",
  proposalType: "amount_update" as const,
  payload: {
    newAmountCents: "-4490000",
    oldAmountCents: "-4200000",
    currency: "COP",
    observationCount: 2,
  },
  createdAt: "2026-04-01T00:00:00Z",
};

const variableFlagProposal = {
  id: 2,
  recurringId: 11,
  label: "Spotify",
  accountLabel: "Bancolombia COP",
  proposalType: "variable_flag" as const,
  payload: {
    detectedAmounts: ["-2000000", "-2500000", "-3000000"],
    currency: "COP",
    observationCount: 3,
  },
  createdAt: "2026-04-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecurringProposalsList", () => {
  it("renders proposal cards for every proposal in the list", () => {
    render(<RecurringProposalsList proposals={[amountUpdateProposal, variableFlagProposal]} />);

    const cards = screen.getAllByTestId("proposal-card");
    expect(cards).toHaveLength(2);

    // Both labels rendered.
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
  });

  it("renders the empty-state element when proposals list is empty", () => {
    render(<RecurringProposalsList proposals={[]} />);

    expect(screen.getByTestId("proposals-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("proposal-card")).not.toBeInTheDocument();
  });

  it("clicking Accept calls acceptProposal with the correct id", async () => {
    acceptProposal.mockResolvedValueOnce({ ok: true });

    const user = userEvent.setup();
    render(<RecurringProposalsList proposals={[amountUpdateProposal]} />);

    await user.click(screen.getByTestId("proposal-accept"));

    expect(acceptProposal).toHaveBeenCalledTimes(1);
    expect(acceptProposal).toHaveBeenCalledWith({ proposalId: amountUpdateProposal.id });
  });

  it("clicking Reject calls rejectProposal with the correct id", async () => {
    rejectProposal.mockResolvedValueOnce({ ok: true });

    const user = userEvent.setup();
    render(<RecurringProposalsList proposals={[amountUpdateProposal]} />);

    await user.click(screen.getByTestId("proposal-reject"));

    expect(rejectProposal).toHaveBeenCalledTimes(1);
    expect(rejectProposal).toHaveBeenCalledWith({ proposalId: amountUpdateProposal.id });
  });

  it("accepted card is removed from the list", async () => {
    acceptProposal.mockResolvedValueOnce({ ok: true });

    const user = userEvent.setup();
    render(<RecurringProposalsList proposals={[amountUpdateProposal, variableFlagProposal]} />);

    expect(screen.getAllByTestId("proposal-card")).toHaveLength(2);

    // Accept the first card.
    const acceptButtons = screen.getAllByTestId("proposal-accept");
    await user.click(acceptButtons[0]);

    // Card removed optimistically.
    expect(screen.getAllByTestId("proposal-card")).toHaveLength(1);
    expect(screen.queryByText("Netflix")).not.toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
  });

  it("shows error message when acceptProposal returns ok=false", async () => {
    acceptProposal.mockResolvedValueOnce({ ok: false, error: "Propuesta no encontrada" });

    const user = userEvent.setup();
    render(<RecurringProposalsList proposals={[amountUpdateProposal]} />);

    await user.click(screen.getByTestId("proposal-accept"));

    expect(screen.getByText("Propuesta no encontrada")).toBeInTheDocument();
    // Card stays visible.
    expect(screen.getByTestId("proposal-card")).toBeInTheDocument();
  });
});
