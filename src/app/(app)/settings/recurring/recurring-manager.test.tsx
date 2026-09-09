// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoisted mocks — all heavy deps mocked before any import.
// ---------------------------------------------------------------------------
const {
  routerPush,
  upsertRecurring,
  archiveRecurring,
  toggleRecurringActive,
  currentSearchParams,
} = vi.hoisted(() => ({
  routerPush: vi.fn(),
  upsertRecurring: vi.fn(),
  archiveRecurring: vi.fn(),
  toggleRecurringActive: vi.fn(),
  currentSearchParams: { value: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => currentSearchParams.value,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./actions", () => ({
  upsertRecurring,
  archiveRecurring,
  toggleRecurringActive,
}));

import { RecurringManager } from "./recurring-manager";

// Radix Dialog relies on pointer-capture + scrollIntoView APIs that jsdom does
// not implement. Shim them globally for this file.
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  upsertRecurring.mockReset();
  archiveRecurring.mockReset();
  toggleRecurringActive.mockReset();
  routerPush.mockReset();
  currentSearchParams.value = new URLSearchParams();
});

afterEach(() => {
  cleanup();
});

const ACCOUNTS = [
  { id: 1, name: "ARQ Ahorros", currency: "USD" as const },
  { id: 2, name: "Bancolombia Ahorros", currency: "COP" as const },
];

const CATEGORIES: { slug: string; name: string; parentSlug: string | null }[] = [];

describe("RecurringManager — currency independence (#803 follow-up: amount reset)", () => {
  it("edit: changing currency clears the amount and shows the re-enter hint", async () => {
    const user = userEvent.setup();
    const item = {
      id: 10,
      accountId: 1,
      accountName: "ARQ Ahorros",
      label: "Pago de Arriendo",
      amountCents: "-63270",
      currency: "USD" as const,
      categorySlug: null,
      dayOfMonth: 1,
      active: true,
      notes: null,
    };

    render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={CATEGORIES}
        items={[item]}
        activeCategory={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog");

    const amountInput = within(dialog).getByLabelText(/amount/i) as HTMLInputElement;
    expect(amountInput.value).toBe("632.7");

    const currencySelect = within(dialog).getByLabelText(/^currency$/i) as HTMLSelectElement;
    expect(currencySelect.value).toBe("USD");

    await user.selectOptions(currencySelect, "COP");

    expect(amountInput.value).toBe("");
    expect(within(dialog).getByText(/re-enter the amount in cop/i)).toBeInTheDocument();
  });

  it("create: changing account auto-follows currency and clears any typed amount", async () => {
    const user = userEvent.setup();

    render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={CATEGORIES}
        items={[]}
        activeCategory={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /new recurring/i }));
    const dialog = await screen.findByRole("dialog");

    const accountSelect = within(dialog).getByLabelText(/account/i) as HTMLSelectElement;
    expect(accountSelect.value).toBe("1"); // defaults to first account (USD)

    const currencySelect = within(dialog).getByLabelText(/^currency$/i) as HTMLSelectElement;
    expect(currencySelect.value).toBe("USD");

    const amountInput = within(dialog).getByLabelText(/amount/i) as HTMLInputElement;
    await user.type(amountInput, "100");
    expect(amountInput.value).toBe("100");

    await user.selectOptions(accountSelect, "2"); // switch to COP account

    expect(currencySelect.value).toBe("COP");
    expect(amountInput.value).toBe("");
    expect(within(dialog).getByText(/re-enter the amount in cop/i)).toBeInTheDocument();
  });

  it("create: explicitly picking a currency is not clobbered by a later account change", async () => {
    const user = userEvent.setup();

    render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={CATEGORIES}
        items={[]}
        activeCategory={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /new recurring/i }));
    const dialog = await screen.findByRole("dialog");

    const accountSelect = within(dialog).getByLabelText(/account/i) as HTMLSelectElement;
    const currencySelect = within(dialog).getByLabelText(/^currency$/i) as HTMLSelectElement;
    const amountInput = within(dialog).getByLabelText(/amount/i) as HTMLInputElement;

    // Account 1 is USD; explicitly force currency to COP (an override, not a follow).
    await user.selectOptions(currencySelect, "COP");
    expect(amountInput.value).toBe("");

    await user.type(amountInput, "2300000");
    expect(amountInput.value).toBe("2300000");

    // Now switch the account — the explicit currency choice must survive untouched.
    await user.selectOptions(accountSelect, "2");

    expect(currencySelect.value).toBe("COP");
    expect(amountInput.value).toBe("2300000");
  });

  it("create: submits accountId=USD account with currency=COP and the right cents", async () => {
    const user = userEvent.setup();
    upsertRecurring.mockResolvedValueOnce(undefined);

    render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={CATEGORIES}
        items={[]}
        activeCategory={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /new recurring/i }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText(/label/i), "Pago de Arriendo");

    const currencySelect = within(dialog).getByLabelText(/^currency$/i) as HTMLSelectElement;
    await user.selectOptions(currencySelect, "COP");

    const amountInput = within(dialog).getByLabelText(/amount/i) as HTMLInputElement;
    await user.type(amountInput, "2300000");

    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(upsertRecurring).toHaveBeenCalledTimes(1);
    });
    expect(upsertRecurring).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 1,
        currency: "COP",
        amount: 2300000,
        direction: "expense",
      }),
    );
  });
});

describe("RecurringManager — account + active-only filters (#733)", () => {
  const FILTER_CATEGORIES = [
    { slug: "arriendo", name: "Arriendo", parentSlug: null },
    { slug: "suscripciones", name: "Suscripciones", parentSlug: null },
  ];

  it("renders account options with formatAccountLabel, not the raw name", () => {
    render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={FILTER_CATEGORIES}
        items={[]}
        activeCategory={null}
      />,
    );

    const accountSelect = screen.getByLabelText("Filtrar por cuenta");
    expect(
      within(accountSelect).getByRole("option", { name: "Todas las cuentas" }),
    ).toBeInTheDocument();
    expect(
      within(accountSelect).getByRole("option", { name: "ARQ Ahorros (USD)" }),
    ).toBeInTheDocument();
    expect(
      within(accountSelect).getByRole("option", { name: "Bancolombia Ahorros (COP)" }),
    ).toBeInTheDocument();
    expect(
      within(accountSelect).queryByRole("option", { name: /^ARQ Ahorros$/ }),
    ).not.toBeInTheDocument();
  });

  it("pushes account into the URL and keeps an existing category param", async () => {
    const user = userEvent.setup();
    currentSearchParams.value = new URLSearchParams("category=arriendo");

    render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={FILTER_CATEGORIES}
        items={[]}
        activeCategory="arriendo"
      />,
    );

    await user.selectOptions(screen.getByLabelText("Filtrar por cuenta"), "1");

    expect(routerPush).toHaveBeenCalledWith("/settings/recurring?category=arriendo&account=1");
  });

  it("Todas las cuentas removes the account param and keeps category", async () => {
    const user = userEvent.setup();
    currentSearchParams.value = new URLSearchParams("category=arriendo&account=1");

    render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={FILTER_CATEGORIES}
        items={[]}
        activeCategory="arriendo"
        activeAccount={1}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Filtrar por cuenta"), "");

    expect(routerPush).toHaveBeenCalledWith("/settings/recurring?category=arriendo");
  });

  it("Solo activas toggle sets and then clears activeOnly without dropping other filters", async () => {
    const user = userEvent.setup();
    currentSearchParams.value = new URLSearchParams("category=arriendo&account=1");

    const { rerender } = render(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={FILTER_CATEGORIES}
        items={[]}
        activeCategory="arriendo"
        activeAccount={1}
        activeOnly={false}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Solo activas" }));
    expect(routerPush).toHaveBeenCalledWith(
      "/settings/recurring?category=arriendo&account=1&activeOnly=true",
    );

    currentSearchParams.value = new URLSearchParams("category=arriendo&account=1&activeOnly=true");
    rerender(
      <RecurringManager
        accounts={ACCOUNTS}
        categories={FILTER_CATEGORIES}
        items={[]}
        activeCategory="arriendo"
        activeAccount={1}
        activeOnly={true}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Solo activas" }));
    expect(routerPush).toHaveBeenLastCalledWith("/settings/recurring?category=arriendo&account=1");
  });
});
