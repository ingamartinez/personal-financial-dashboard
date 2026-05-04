// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoist mocks before any imports that reference the mocked modules.
// ---------------------------------------------------------------------------
const { updateTransactionCategory, classifySingleWithAi, toastSuccess, toastError } = vi.hoisted(
  () => ({
    updateTransactionCategory: vi.fn(),
    classifySingleWithAi: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }),
);

vi.mock("@/app/(app)/transactions/actions", () => ({
  updateTransactionCategory,
  classifySingleWithAi,
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: vi.fn() },
}));

// CategoryCombobox uses Radix Popover + cmdk — shim pointer-capture and scrollIntoView.
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
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  updateTransactionCategory.mockReset();
  classifySingleWithAi.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

import { CategoryCell } from "./category-cell";

const OPTIONS = [
  { slug: "alimentacion", name: "Alimentación", parentSlug: null },
  { slug: "transporte", name: "Transporte", parentSlug: null },
];

// ---------------------------------------------------------------------------
// #682: transfer branch
// ---------------------------------------------------------------------------
describe("CategoryCell — channel=transfer (issue #682)", () => {
  it("renders the 'Transferencia' badge when channel is 'transfer'", () => {
    render(<CategoryCell txId={1} value={null} options={OPTIONS} channel="transfer" />);

    expect(screen.getByTestId("transfer-category-badge")).toBeInTheDocument();
    expect(screen.getByTestId("transfer-category-badge")).toHaveTextContent("Transferencia");
  });

  it("does NOT render the combobox when channel is 'transfer'", () => {
    render(<CategoryCell txId={1} value={null} options={OPTIONS} channel="transfer" />);

    // The combobox trigger has role="combobox"
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("does NOT render the sparkles button when channel is 'transfer'", () => {
    render(<CategoryCell txId={1} value={null} options={OPTIONS} channel="transfer" />);

    expect(screen.queryByLabelText("Classify with AI")).not.toBeInTheDocument();
  });

  it("renders the '¿Por qué?' trigger button when channel is 'transfer'", () => {
    render(<CategoryCell txId={1} value={null} options={OPTIONS} channel="transfer" />);

    const btn = screen.getByTestId("transfer-category-why");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("¿Por qué?");
  });

  it("clicking '¿Por qué?' opens the explainer dialog", async () => {
    const user = userEvent.setup();
    render(<CategoryCell txId={1} value={null} options={OPTIONS} channel="transfer" />);

    await user.click(screen.getByTestId("transfer-category-why"));

    expect(await screen.findByText("¿Por qué no tiene categoría?")).toBeInTheDocument();
    expect(screen.getByText(/movimiento de plata entre cuentas/i)).toBeInTheDocument();
  });

  it("closes the explainer dialog when 'Entendido' is clicked", async () => {
    const user = userEvent.setup();
    render(<CategoryCell txId={1} value={null} options={OPTIONS} channel="transfer" />);

    await user.click(screen.getByTestId("transfer-category-why"));
    await screen.findByText("¿Por qué no tiene categoría?");

    await user.click(screen.getByRole("button", { name: /entendido/i }));

    await waitFor(() => {
      expect(screen.queryByText("¿Por qué no tiene categoría?")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// #766: cash_withdrawal branch
// ---------------------------------------------------------------------------
describe("CategoryCell — channel=cash_withdrawal (issue #766)", () => {
  it("renders the 'Retiro de efectivo' badge when channel is 'cash_withdrawal'", () => {
    render(<CategoryCell txId={10} value={null} options={OPTIONS} channel="cash_withdrawal" />);

    expect(screen.getByTestId("cash-withdrawal-category-badge")).toBeInTheDocument();
    expect(screen.getByTestId("cash-withdrawal-category-badge")).toHaveTextContent(
      "Retiro de efectivo",
    );
  });

  it("does NOT render the combobox when channel is 'cash_withdrawal'", () => {
    render(<CategoryCell txId={10} value={null} options={OPTIONS} channel="cash_withdrawal" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("does NOT render the sparkles button when channel is 'cash_withdrawal'", () => {
    render(<CategoryCell txId={10} value={null} options={OPTIONS} channel="cash_withdrawal" />);
    expect(screen.queryByLabelText("Classify with AI")).not.toBeInTheDocument();
  });

  it("renders the '¿Por qué?' trigger button for cash_withdrawal", () => {
    render(<CategoryCell txId={10} value={null} options={OPTIONS} channel="cash_withdrawal" />);

    const btn = screen.getByTestId("cash-withdrawal-category-why");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("¿Por qué?");
  });

  it("clicking '¿Por qué?' opens the cash withdrawal explainer dialog", async () => {
    const user = userEvent.setup();
    render(<CategoryCell txId={10} value={null} options={OPTIONS} channel="cash_withdrawal" />);

    await user.click(screen.getByTestId("cash-withdrawal-category-why"));

    expect(await screen.findByText("¿Por qué no tiene categoría?")).toBeInTheDocument();
    expect(screen.getByText(/efectivo en tu billetera/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #766: sparkle handler uses Result type (not throw)
// ---------------------------------------------------------------------------
describe("CategoryCell — sparkle handler Result type (issue #766)", () => {
  it("shows toast.error with the returned message when status is error", async () => {
    classifySingleWithAi.mockResolvedValueOnce({
      status: "error",
      code: "ai_returned_null",
      message: "La IA no pudo clasificar esta transacción",
    });

    const user = userEvent.setup();
    render(<CategoryCell txId={20} value={null} options={OPTIONS} />);

    await user.click(screen.getByLabelText("Classify with AI"));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("La IA no pudo clasificar esta transacción");
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows toast.success with category name when status is ok and confidence >= 50", async () => {
    classifySingleWithAi.mockResolvedValueOnce({
      status: "ok",
      categorySlug: "alimentacion",
      categoryName: "Alimentación",
      confidence: 85,
    });

    const user = userEvent.setup();
    render(<CategoryCell txId={21} value={null} options={OPTIONS} />);

    await user.click(screen.getByLabelText("Classify with AI"));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Classified as Alimentación (85%)");
    });
  });
});

// ---------------------------------------------------------------------------
// Default branch (no channel or non-transfer channel)
// ---------------------------------------------------------------------------
describe("CategoryCell — default (non-transfer)", () => {
  it("renders the combobox when no channel is provided", () => {
    render(<CategoryCell txId={2} value="alimentacion" options={OPTIONS} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders the sparkles button when value is null (unclassified)", () => {
    render(<CategoryCell txId={3} value={null} options={OPTIONS} />);
    expect(screen.getByLabelText("Classify with AI")).toBeInTheDocument();
  });

  it("does NOT render the sparkles button when value is provided (classified)", () => {
    render(<CategoryCell txId={4} value="transporte" options={OPTIONS} />);
    expect(screen.queryByLabelText("Classify with AI")).not.toBeInTheDocument();
  });

  it("does NOT render the transfer badge for non-transfer channel", () => {
    render(<CategoryCell txId={5} value={null} options={OPTIONS} channel="bank" />);
    expect(screen.queryByTestId("transfer-category-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transfer-category-why")).not.toBeInTheDocument();
  });

  it("does NOT render the transfer badge when channel is undefined", () => {
    render(<CategoryCell txId={6} value={null} options={OPTIONS} />);
    expect(screen.queryByTestId("transfer-category-badge")).not.toBeInTheDocument();
  });
});
