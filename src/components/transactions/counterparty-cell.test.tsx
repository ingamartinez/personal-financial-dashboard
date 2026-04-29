// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoist mocks before any imports that reference the mocked modules.
// ---------------------------------------------------------------------------
const { setTransactionCounterparty, toastError, toastSuccess } = vi.hoisted(() => ({
  setTransactionCounterparty: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/app/(app)/transactions/actions", () => ({ setTransactionCounterparty }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

import { CounterpartyCell } from "./counterparty-cell";

// Radix Popover + Command + cmdk use pointer-capture, scrollIntoView, and
// ResizeObserver APIs that jsdom does not implement natively — shim them.
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
  // cmdk uses ResizeObserver internally
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  setTransactionCounterparty.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

const OPTIONS = [
  { id: 1, displayName: "Amazon", type: "merchant" as const },
  { id: 2, displayName: "Rappi", type: "merchant" as const },
];

describe("CounterpartyCell", () => {
  it("calls setTransactionCounterparty with counterpartyId when picking an existing option", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({ status: "ok" });

    render(<CounterpartyCell txId={99} counterparty={null} options={OPTIONS} />);

    // Open the combobox
    await user.click(screen.getByRole("combobox"));

    // Pick the first option
    const option = await screen.findByText("Amazon");
    await user.click(option);

    await waitFor(() => {
      expect(setTransactionCounterparty).toHaveBeenCalledWith({
        txId: 99,
        counterpartyId: 1,
      });
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("calls setTransactionCounterparty with displayName when creating a new counterparty", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({ status: "ok" });

    render(<CounterpartyCell txId={77} counterparty={null} options={OPTIONS} />);

    // Open the combobox
    await user.click(screen.getByRole("combobox"));

    // Type a name that doesn't exist
    const input = await screen.findByPlaceholderText(/buscar counterparty/i);
    await user.type(input, "Nuevo Negocio");

    // The "+ Crear nuevo" item should appear
    const createItem = await screen.findByText(/crear nuevo/i);
    await user.click(createItem);

    await waitFor(() => {
      expect(setTransactionCounterparty).toHaveBeenCalledWith({
        txId: 77,
        counterpartyId: null,
        displayName: "Nuevo Negocio",
      });
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("calls setTransactionCounterparty with null to unlink an assigned counterparty", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({ status: "ok" });

    const currentCounterparty = {
      id: 1,
      displayName: "Amazon",
      type: "merchant" as const,
      isSalary: false,
      defaultCategorySlug: null,
      notes: null,
      aliases: [],
    };

    render(<CounterpartyCell txId={55} counterparty={currentCounterparty} options={OPTIONS} />);

    // Open the combobox
    await user.click(screen.getByRole("combobox"));

    // "Sin asignar" unlink item should be visible (only when a counterparty is assigned)
    const unlinkItem = await screen.findByText("Sin asignar");
    await user.click(unlinkItem);

    await waitFor(() => {
      expect(setTransactionCounterparty).toHaveBeenCalledWith({
        txId: 55,
        counterpartyId: null,
      });
    });
    expect(toastSuccess).toHaveBeenCalled();
  });
});
