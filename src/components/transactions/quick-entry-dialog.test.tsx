// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { createManualEntry, toastError, toastSuccess } = vi.hoisted(() => ({
  createManualEntry: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/app/(app)/transactions/actions", () => ({ createManualEntry }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

import { QuickEntryDialog } from "./quick-entry-dialog";

// Radix Dialog relies on pointer-capture + scrollIntoView APIs that jsdom does
// not implement. Shim them globally for this file.
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
  createManualEntry.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("QuickEntryDialog", () => {
  // Regression for #469 — single-account user who never touches the account
  // `<select>` used to get blocked by the "Pick an account" toast because the
  // `useState` initializer captured accountId="" when accounts briefly rendered
  // empty during RSC revalidation / pre-seed.
  it("submits an expense with a single account without any select interaction", async () => {
    const user = userEvent.setup();
    createManualEntry.mockResolvedValueOnce(undefined);

    render(
      <QuickEntryDialog
        accounts={[{ id: 42, name: "Main COP", currency: "COP" }]}
        categories={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add entry/i }));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/amount/i), "1234");
    await user.click(within(dialog).getByRole("button", { name: /^add expense$/i }));

    await waitFor(() => {
      expect(createManualEntry).toHaveBeenCalledTimes(1);
    });
    expect(createManualEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "expense", accountId: 42, amount: "1234" }),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Expense added");
  });

  it("preserves multi-account behavior: default is first COP, user can pick another", async () => {
    const user = userEvent.setup();
    createManualEntry.mockResolvedValueOnce(undefined);

    render(
      <QuickEntryDialog
        accounts={[
          { id: 1, name: "USD Savings", currency: "USD" },
          { id: 2, name: "COP Main", currency: "COP" },
          { id: 3, name: "COP Secondary", currency: "COP" },
        ]}
        categories={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add entry/i }));
    const dialog = await screen.findByRole("dialog");

    const select = within(dialog).getByLabelText(/account/i) as HTMLSelectElement;
    expect(select.value).toBe("2");

    await user.selectOptions(select, "3");
    await user.type(within(dialog).getByLabelText(/amount/i), "500");
    await user.click(within(dialog).getByRole("button", { name: /^add expense$/i }));

    await waitFor(() => {
      expect(createManualEntry).toHaveBeenCalledTimes(1);
    });
    expect(createManualEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "expense", accountId: 3, amount: "500" }),
    );
  });

  it("toggles to income and submits with kind='income' (#470)", async () => {
    const user = userEvent.setup();
    createManualEntry.mockResolvedValueOnce(undefined);

    render(
      <QuickEntryDialog
        accounts={[{ id: 42, name: "Main COP", currency: "COP" }]}
        categories={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add entry/i }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("radio", { name: /income/i }));
    expect(within(dialog).getByRole("radio", { name: /income/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.type(within(dialog).getByLabelText(/amount/i), "750");
    await user.click(within(dialog).getByRole("button", { name: /^add income$/i }));

    await waitFor(() => {
      expect(createManualEntry).toHaveBeenCalledTimes(1);
    });
    expect(createManualEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "income", accountId: 42, amount: "750" }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Income added");
  });

  it("category picker swaps between expense and income trees when the toggle flips", async () => {
    const user = userEvent.setup();

    render(
      <QuickEntryDialog
        accounts={[{ id: 42, name: "Main COP", currency: "COP" }]}
        categories={[
          { slug: "ingresos", name: "Ingresos", parentSlug: null },
          { slug: "salario", name: "Salario", parentSlug: "ingresos" },
          { slug: "alimentacion", name: "Alimentación", parentSlug: null },
          { slug: "mercado", name: "Mercado", parentSlug: "alimentacion" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add entry/i }));
    const dialog = await screen.findByRole("dialog");
    const categorySelect = within(dialog).getByLabelText(/category/i) as HTMLSelectElement;

    const expenseOptions = Array.from(categorySelect.options).map((o) => o.value);
    expect(expenseOptions).toEqual(["", "alimentacion", "mercado"]);

    await user.click(within(dialog).getByRole("radio", { name: /income/i }));

    const incomeOptions = Array.from(categorySelect.options).map((o) => o.value);
    expect(incomeOptions).toEqual(["", "ingresos", "salario"]);
  });

  it("clears the category selection when switching kind (no cross-kind leaks)", async () => {
    const user = userEvent.setup();
    createManualEntry.mockResolvedValueOnce(undefined);

    render(
      <QuickEntryDialog
        accounts={[{ id: 42, name: "Main COP", currency: "COP" }]}
        categories={[
          { slug: "ingresos", name: "Ingresos", parentSlug: null },
          { slug: "salario", name: "Salario", parentSlug: "ingresos" },
          { slug: "alimentacion", name: "Alimentación", parentSlug: null },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add entry/i }));
    const dialog = await screen.findByRole("dialog");
    const categorySelect = within(dialog).getByLabelText(/category/i) as HTMLSelectElement;

    await user.selectOptions(categorySelect, "alimentacion");
    expect(categorySelect.value).toBe("alimentacion");

    await user.click(within(dialog).getByRole("radio", { name: /income/i }));
    expect(categorySelect.value).toBe("");

    await user.type(within(dialog).getByLabelText(/amount/i), "100");
    await user.click(within(dialog).getByRole("button", { name: /^add income$/i }));

    await waitFor(() => {
      expect(createManualEntry).toHaveBeenCalledTimes(1);
    });
    expect(createManualEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "income", categorySlug: null }),
    );
  });
});
