// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// The toggle imports the real "use server" actions module — mock it, matching
// recurring-list.test.tsx.
// ---------------------------------------------------------------------------
const { markOccurrencePaidExternal, unmarkOccurrencePaidExternal, toastSuccess, toastError } =
  vi.hoisted(() => ({
    markOccurrencePaidExternal: vi.fn(),
    unmarkOccurrencePaidExternal: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }));

vi.mock("@/app/(app)/settings/recurring/actions", () => ({
  markOccurrencePaidExternal,
  unmarkOccurrencePaidExternal,
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

import { PaidExternalStateLine, PaidExternalToggle } from "./paid-external-toggle";

beforeEach(() => {
  markOccurrencePaidExternal.mockReset();
  unmarkOccurrencePaidExternal.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("PaidExternalStateLine (#1034)", () => {
  it("says the month was paid from an account findash does not track", () => {
    render(<PaidExternalStateLine yearMonth="2026-11" />);

    const line = screen.getByTestId("paid-external-state");
    expect(line).toHaveTextContent(/cuenta no registrada/i);
    expect(line).toHaveTextContent("2026-11");
  });
});

describe("PaidExternalToggle (#1034)", () => {
  it("renders the mark action when the slot is not marked", () => {
    render(<PaidExternalToggle recurringId={9} yearMonth="2026-11" marked={false} />);

    expect(screen.getByRole("button", { name: /marcar pagado/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /desmarcar/i })).not.toBeInTheDocument();
  });

  it("calls markOccurrencePaidExternal with the slot coordinates", async () => {
    markOccurrencePaidExternal.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<PaidExternalToggle recurringId={9} yearMonth="2026-11" marked={false} />);

    await user.click(screen.getByRole("button", { name: /marcar pagado/i }));

    await waitFor(() =>
      expect(markOccurrencePaidExternal).toHaveBeenCalledWith({
        recurringId: 9,
        yearMonth: "2026-11",
      }),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("renders the unmark action when the slot is marked and calls unmarkOccurrencePaidExternal", async () => {
    unmarkOccurrencePaidExternal.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<PaidExternalToggle recurringId={10} yearMonth="2026-11" marked={true} />);

    await user.click(screen.getByRole("button", { name: /desmarcar/i }));

    await waitFor(() =>
      expect(unmarkOccurrencePaidExternal).toHaveBeenCalledWith({
        recurringId: 10,
        yearMonth: "2026-11",
      }),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("surfaces a refusal from the action instead of silently succeeding", async () => {
    markOccurrencePaidExternal.mockRejectedValueOnce(
      new Error("Already covered this month by tx #42"),
    );
    const user = userEvent.setup();
    render(<PaidExternalToggle recurringId={9} yearMonth="2026-11" marked={false} />);

    await user.click(screen.getByRole("button", { name: /marcar pagado/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({
      description: "Already covered this month by tx #42",
    });
  });
});
