// @vitest-environment jsdom
// #762: Smoke tests for LinkTransferDialog.
// Covers: open → load candidates → select → confirm → toast.
// Pattern follows quick-expense-dialog.test.tsx (Radix shims).

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------
const { findTransferCandidates, linkExistingAsTransfer, toastSuccess, toastError } = vi.hoisted(
  () => ({
    findTransferCandidates: vi.fn(),
    linkExistingAsTransfer: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }),
);

vi.mock("@/app/(app)/transactions/actions", () => ({
  findTransferCandidates,
  linkExistingAsTransfer,
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

// ---------------------------------------------------------------------------
// Radix + jsdom shims
// ---------------------------------------------------------------------------
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  findTransferCandidates.mockReset();
  linkExistingAsTransfer.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

import { LinkTransferDialog } from "./link-transfer-dialog";

const SOURCE_TX = {
  id: 42,
  amountCents: BigInt(-100_000),
  currency: "COP" as const,
};

const CANDIDATE = {
  id: 99,
  occurredAt: new Date("2026-04-15T12:00:00Z").toISOString(),
  amountCents: BigInt(100_000),
  currency: "COP",
  descriptionRaw: "Transferencia recibida",
  descriptionClean: "Transferencia recibida",
  merchant: null,
  accountId: 5,
  accountName: "Visa *1234",
  accountCurrency: "COP",
  accountInstitution: "bancolombia",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("LinkTransferDialog — open shows candidates", () => {
  it("renders the warning and candidate list when opened", async () => {
    findTransferCandidates.mockResolvedValue([CANDIDATE]);

    render(
      <LinkTransferDialog open={true} onOpenChange={() => {}} sourceTransaction={SOURCE_TX} />,
    );

    // Warning should be visible immediately.
    expect(screen.getByText(/quita la categoría de ambas/i)).toBeInTheDocument();

    // Candidates load asynchronously.
    await waitFor(() => {
      expect(screen.getByTestId(`transfer-candidate-${CANDIDATE.id}`)).toBeInTheDocument();
    });

    expect(screen.getByText("Transferencia recibida")).toBeInTheDocument();
  });

  it("shows empty state message when no candidates found", async () => {
    findTransferCandidates.mockResolvedValue([]);

    render(
      <LinkTransferDialog open={true} onOpenChange={() => {}} sourceTransaction={SOURCE_TX} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/No hay candidatas/i)).toBeInTheDocument();
    });
  });
});

describe("LinkTransferDialog — select and confirm", () => {
  it("confirm button calls linkExistingAsTransfer and toasts on success", async () => {
    const user = userEvent.setup();
    findTransferCandidates.mockResolvedValue([CANDIDATE]);
    linkExistingAsTransfer.mockResolvedValue({ status: "ok" });

    const onOpenChange = vi.fn();
    render(
      <LinkTransferDialog open={true} onOpenChange={onOpenChange} sourceTransaction={SOURCE_TX} />,
    );

    // Wait for candidate to appear.
    await waitFor(() => {
      expect(screen.getByTestId(`transfer-candidate-${CANDIDATE.id}`)).toBeInTheDocument();
    });

    // Confirm button should be disabled before selection.
    expect(screen.getByRole("button", { name: /Linkear como transferencia/i })).toBeDisabled();

    // Select the candidate.
    await user.click(screen.getByTestId(`transfer-candidate-${CANDIDATE.id}`));

    // Confirm button should now be enabled.
    expect(screen.getByRole("button", { name: /Linkear como transferencia/i })).toBeEnabled();

    // Click confirm.
    await user.click(screen.getByRole("button", { name: /Linkear como transferencia/i }));

    await waitFor(() => {
      expect(linkExistingAsTransfer).toHaveBeenCalledWith({
        txIdA: SOURCE_TX.id,
        txIdB: CANDIDATE.id,
      });
    });

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("shows error toast when linkExistingAsTransfer fails", async () => {
    const user = userEvent.setup();
    findTransferCandidates.mockResolvedValue([CANDIDATE]);
    linkExistingAsTransfer.mockResolvedValue({
      status: "error",
      message: "Ya pertenece a otro grupo.",
    });

    render(
      <LinkTransferDialog open={true} onOpenChange={() => {}} sourceTransaction={SOURCE_TX} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(`transfer-candidate-${CANDIDATE.id}`)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`transfer-candidate-${CANDIDATE.id}`));
    await user.click(screen.getByRole("button", { name: /Linkear como transferencia/i }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "No se pudo linkear",
        expect.objectContaining({ description: "Ya pertenece a otro grupo." }),
      );
    });
  });
});
