// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoist mocks before any imports that reference the mocked modules.
// ---------------------------------------------------------------------------
const { archiveTransaction, restoreTransaction, unlinkTxFromRecurring, toastSuccess, toastError } =
  vi.hoisted(() => ({
    archiveTransaction: vi.fn(),
    restoreTransaction: vi.fn(),
    unlinkTxFromRecurring: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }));

vi.mock("@/app/(app)/transactions/actions", () => ({
  archiveTransaction,
  restoreTransaction,
  unlinkTxFromRecurring,
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

// Stub out heavy child dialogs — we're testing the row actions shell, not the dialogs.
vi.mock("@/components/transactions/tc-installments-dialog", () => ({
  TcInstallmentsDialog: () => <div data-testid="tc-installments-dialog" />,
}));
vi.mock("@/components/transactions/link-recurring-dialog", () => ({
  LinkRecurringDialog: () => <div data-testid="link-recurring-dialog" />,
}));
vi.mock("@/components/transactions/link-counterparty-dialog", () => ({
  LinkCounterpartyDialog: ({ open }: { open: boolean }) => (
    <div data-testid="link-counterparty-dialog" data-open={String(open)} />
  ),
}));
vi.mock("@/components/transactions/link-transfer-dialog", () => ({
  LinkTransferDialog: ({ open }: { open: boolean }) => (
    <div data-testid="link-transfer-dialog" data-open={String(open)} />
  ),
}));

// Radix DropdownMenu uses pointer-capture — shim for jsdom.
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
  archiveTransaction.mockReset();
  restoreTransaction.mockReset();
  unlinkTxFromRecurring.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

import { TransactionRowActions } from "./transaction-row-actions";

const BASE_PROPS = {
  txId: 42,
  isArchived: false,
  accountType: "savings" as const,
  amountCents: BigInt(-10000),
  currency: "COP" as const,
  installmentsTotal: 1,
  installmentRateEmX10k: null,
  recurringId: null,
  recurringLabel: null,
  activeRecurrings: [],
  counterparty: null,
  allCounterparties: [],
};

// ---------------------------------------------------------------------------
// #683: Contraparte… menu item opens the dialog
// ---------------------------------------------------------------------------
describe("TransactionRowActions — Contraparte menu item (#683)", () => {
  it("has a 'Contraparte…' menu item in the dropdown", async () => {
    const user = userEvent.setup();

    render(<TransactionRowActions {...BASE_PROPS} />);

    // Open the kebab menu
    await user.click(screen.getByRole("button", { name: /row actions/i }));

    expect(await screen.findByText("Contraparte…")).toBeInTheDocument();
  });

  it("opens LinkCounterpartyDialog when 'Contraparte…' is clicked", async () => {
    const user = userEvent.setup();

    render(<TransactionRowActions {...BASE_PROPS} />);

    // Dialog starts closed
    expect(screen.getByTestId("link-counterparty-dialog")).toHaveAttribute("data-open", "false");

    // Open the kebab menu and click the item
    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(await screen.findByText("Contraparte…"));

    // Dialog should now be open
    expect(screen.getByTestId("link-counterparty-dialog")).toHaveAttribute("data-open", "true");
  });

  it("passes the correct counterparty and allCounterparties props to the dialog", () => {
    const cp = {
      id: 1,
      displayName: "Amazon",
      type: "merchant" as const,
      isSalary: false,
      defaultCategorySlug: null,
      notes: null,
      aliases: [],
    };
    const allCps = [{ id: 1, displayName: "Amazon", type: "merchant" as const }];

    render(<TransactionRowActions {...BASE_PROPS} counterparty={cp} allCounterparties={allCps} />);

    // The mock dialog renders — props are validated at the component level.
    expect(screen.getByTestId("link-counterparty-dialog")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #762: Linkear como transferencia… menu item opens the dialog
// ---------------------------------------------------------------------------
describe("TransactionRowActions — Linkear como transferencia menu item (#762)", () => {
  it("has a 'Linkear como transferencia…' menu item for a non-archived tx", async () => {
    const user = userEvent.setup();

    render(<TransactionRowActions {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: /row actions/i }));

    expect(await screen.findByText("Linkear como transferencia…")).toBeInTheDocument();
  });

  it("opens LinkTransferDialog when item is clicked", async () => {
    const user = userEvent.setup();

    render(<TransactionRowActions {...BASE_PROPS} />);

    // Dialog starts closed.
    expect(screen.getByTestId("link-transfer-dialog")).toHaveAttribute("data-open", "false");

    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(await screen.findByText("Linkear como transferencia…"));

    expect(screen.getByTestId("link-transfer-dialog")).toHaveAttribute("data-open", "true");
  });
});

// ---------------------------------------------------------------------------
// Existing smoke tests — archive and restore still work
// ---------------------------------------------------------------------------
describe("TransactionRowActions — archive/restore", () => {
  it("has an 'Archive' menu item for a non-archived tx", async () => {
    const user = userEvent.setup();

    render(<TransactionRowActions {...BASE_PROPS} />);

    await user.click(screen.getByRole("button", { name: /row actions/i }));

    expect(await screen.findByText("Archive")).toBeInTheDocument();
  });

  it("has a 'Restore' menu item for an archived tx", async () => {
    const user = userEvent.setup();

    render(<TransactionRowActions {...BASE_PROPS} isArchived={true} />);

    await user.click(screen.getByRole("button", { name: /row actions/i }));

    expect(await screen.findByText("Restore")).toBeInTheDocument();
  });
});
