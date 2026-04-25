// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { createManualExpense, toastError, toastSuccess } = vi.hoisted(() => ({
  createManualExpense: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/app/(app)/transactions/actions", () => ({ createManualExpense }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

import { QuickExpenseDialog } from "./quick-expense-dialog";

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
  createManualExpense.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("QuickExpenseDialog", () => {
  // Regression for #469 — single-account user who never touches the account
  // `<select>` used to get blocked by the "Pick an account" toast because the
  // `useState` initializer captured accountId="" when accounts briefly rendered
  // empty during RSC revalidation / pre-seed.
  it("submits with a single account without any select interaction", async () => {
    const user = userEvent.setup();
    createManualExpense.mockResolvedValueOnce(undefined);

    render(
      <QuickExpenseDialog
        accounts={[{ id: 42, name: "Main COP", currency: "COP" }]}
        categories={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add expense/i }));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/amount/i), "1234");
    await user.click(within(dialog).getByRole("button", { name: /^add expense$/i }));

    await waitFor(() => {
      expect(createManualExpense).toHaveBeenCalledTimes(1);
    });
    expect(createManualExpense).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 42, amount: "1234" }),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Expense added");
  });

  it("preserves multi-account behavior: default is first COP, user can pick another", async () => {
    const user = userEvent.setup();
    createManualExpense.mockResolvedValueOnce(undefined);

    render(
      <QuickExpenseDialog
        accounts={[
          { id: 1, name: "USD Savings", currency: "USD" },
          { id: 2, name: "COP Main", currency: "COP" },
          { id: 3, name: "COP Secondary", currency: "COP" },
        ]}
        categories={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add expense/i }));
    const dialog = await screen.findByRole("dialog");

    // Default select value is the first COP account (id=2), not the first row.
    const select = within(dialog).getByLabelText(/account/i) as HTMLSelectElement;
    expect(select.value).toBe("2");

    // User picks a different account → submit uses that one.
    await user.selectOptions(select, "3");
    await user.type(within(dialog).getByLabelText(/amount/i), "500");
    await user.click(within(dialog).getByRole("button", { name: /^add expense$/i }));

    await waitFor(() => {
      expect(createManualExpense).toHaveBeenCalledTimes(1);
    });
    expect(createManualExpense).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 3, amount: "500" }),
    );
  });
});
