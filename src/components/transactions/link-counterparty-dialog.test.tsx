// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoist mocks before any imports that reference the mocked modules.
// ---------------------------------------------------------------------------
const { setTransactionCounterparty, toastSuccess, toastError } = vi.hoisted(() => ({
  setTransactionCounterparty: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/app/(app)/transactions/actions", () => ({ setTransactionCounterparty }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

// Radix Dialog + Command + cmdk use pointer-capture, scrollIntoView, and
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
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  setTransactionCounterparty.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

import { LinkCounterpartyDialog } from "./link-counterparty-dialog";

const OPTIONS = [
  { id: 1, displayName: "Amazon", type: "merchant" as const },
  { id: 2, displayName: "Rappi", type: "merchant" as const },
];

function renderDialog(overrides: Partial<Parameters<typeof LinkCounterpartyDialog>[0]> = {}) {
  const defaults = {
    open: true,
    onOpenChange: vi.fn(),
    txId: 99,
    current: null,
    options: OPTIONS,
    onAssigned: vi.fn(),
  };
  return render(<LinkCounterpartyDialog {...defaults} {...overrides} />);
}

// ---------------------------------------------------------------------------
// Pick existing counterparty
// ---------------------------------------------------------------------------
describe("LinkCounterpartyDialog — pick existing", () => {
  it("calls setTransactionCounterparty with counterpartyId when picking an option", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({ status: "ok" });
    const onOpenChange = vi.fn();
    const onAssigned = vi.fn();

    renderDialog({ onOpenChange, onAssigned });

    const amazon = await screen.findByText("Amazon");
    await user.click(amazon);

    await waitFor(() => {
      expect(setTransactionCounterparty).toHaveBeenCalledWith({
        txId: 99,
        counterpartyId: 1,
      });
    });

    expect(toastSuccess).toHaveBeenCalledWith("Contraparte asignada");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAssigned).toHaveBeenCalled();
  });

  it("shows a toast error when pick fails", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({
      status: "error",
      message: "No encontrado",
    });

    renderDialog();

    const amazon = await screen.findByText("Amazon");
    await user.click(amazon);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("No encontrado");
    });
  });
});

// ---------------------------------------------------------------------------
// Create on-the-fly
// ---------------------------------------------------------------------------
describe("LinkCounterpartyDialog — create", () => {
  it("shows 'Crear «X»' item when search has no exact match", async () => {
    const user = userEvent.setup();

    renderDialog();

    const input = screen.getByPlaceholderText("Buscar contraparte…");
    await user.type(input, "Nuevo Negocio");

    const createItem = await screen.findByTestId("create-counterparty-item");
    expect(createItem).toBeInTheDocument();
    expect(createItem).toHaveTextContent("Crear");
    expect(createItem).toHaveTextContent("«Nuevo Negocio»");
  });

  it("calls setTransactionCounterparty with displayName when creating", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({ status: "ok" });
    const onAssigned = vi.fn();

    renderDialog({ onAssigned });

    const input = screen.getByPlaceholderText("Buscar contraparte…");
    await user.type(input, "Nuevo Negocio");

    const createItem = await screen.findByTestId("create-counterparty-item");
    await user.click(createItem);

    await waitFor(() => {
      expect(setTransactionCounterparty).toHaveBeenCalledWith({
        txId: 99,
        counterpartyId: null,
        displayName: "Nuevo Negocio",
      });
    });

    expect(toastSuccess).toHaveBeenCalledWith('Contraparte "Nuevo Negocio" creada y asignada');
    expect(onAssigned).toHaveBeenCalled();
  });

  it("does NOT show 'Crear' when search exactly matches an existing option", async () => {
    const user = userEvent.setup();

    renderDialog();

    const input = screen.getByPlaceholderText("Buscar contraparte…");
    await user.type(input, "Amazon");

    // Exact match — create item should NOT appear
    await waitFor(() => {
      expect(screen.queryByTestId("create-counterparty-item")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Unlink (desvincular)
// ---------------------------------------------------------------------------
describe("LinkCounterpartyDialog — unlink", () => {
  const CURRENT = {
    id: 1,
    displayName: "Amazon",
    type: "merchant" as const,
    isSalary: false,
    defaultCategorySlug: null,
    notes: null,
    aliases: [],
  };

  it("shows the Desvincular button when current is non-null", () => {
    renderDialog({ current: CURRENT });

    expect(screen.getByRole("button", { name: /desvincular/i })).toBeInTheDocument();
  });

  it("does NOT show the Desvincular button when current is null", () => {
    renderDialog({ current: null });

    expect(screen.queryByRole("button", { name: /desvincular/i })).not.toBeInTheDocument();
  });

  it("calls setTransactionCounterparty with null to unlink", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({ status: "ok" });
    const onAssigned = vi.fn();

    renderDialog({ current: CURRENT, onAssigned });

    const unlinkBtn = screen.getByRole("button", { name: /desvincular/i });
    await user.click(unlinkBtn);

    await waitFor(() => {
      expect(setTransactionCounterparty).toHaveBeenCalledWith({
        txId: 99,
        counterpartyId: null,
      });
    });

    expect(toastSuccess).toHaveBeenCalledWith("Contraparte desvinculada");
    expect(onAssigned).toHaveBeenCalled();
  });

  it("shows a toast error when unlink fails", async () => {
    const user = userEvent.setup();
    setTransactionCounterparty.mockResolvedValueOnce({
      status: "error",
      message: "Error al desvincular",
    });

    renderDialog({ current: CURRENT });

    await user.click(screen.getByRole("button", { name: /desvincular/i }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Error al desvincular");
    });
  });
});
