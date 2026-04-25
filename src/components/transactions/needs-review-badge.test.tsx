// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GmailAmbiguousReceipt } from "@/lib/types";

// Shared fetch mock — hoisted so vi.mock factories can reference it
const { fetchMock, toastSuccess, toastError, routerRefresh } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  routerRefresh: vi.fn(),
}));

vi.stubGlobal("fetch", fetchMock);
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

// Import component AFTER stubs are registered
import { NeedsReviewBadge } from "./needs-review-badge";

// Radix Dialog relies on pointer-capture + scrollIntoView APIs that jsdom
// does not implement. Shim them globally for this file.
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
  fetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  cleanup();
});

const RECEIPT_A: GmailAmbiguousReceipt = {
  id: 10,
  gateway: "mercado_pago",
  merchant: "Rappi SAS",
  amountCents: "50000",
  currency: "COP",
  occurredAt: "2026-04-01T10:30:00.000Z",
};

const RECEIPT_B: GmailAmbiguousReceipt = {
  id: 11,
  gateway: "payu",
  merchant: "Domicilios.com",
  amountCents: "75000",
  currency: "COP",
  occurredAt: "2026-04-02T15:00:00.000Z",
};

function makeProps(receipts = [RECEIPT_A]) {
  return {
    receipts,
    transactionId: 42,
    txDescription: "MERCHANT TEST",
    txAmountCents: "-50000",
    txOccurredAt: "2026-04-01T10:00:00.000Z",
  };
}

describe("NeedsReviewBadge", () => {
  it("renders the badge button", () => {
    render(<NeedsReviewBadge {...makeProps()} />);
    const btn = screen.getByRole("button", { name: /email enrichment available/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("title", "Email enrichment available — multiple candidates");
  });

  it("opens the disambiguation dialog when badge is clicked", async () => {
    const user = userEvent.setup();
    render(<NeedsReviewBadge {...makeProps()} />);

    await user.click(screen.getByRole("button", { name: /email enrichment available/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Confirma el merchant real")).toBeInTheDocument();
  });

  it("renders all candidate receipts in the dialog", async () => {
    const user = userEvent.setup();
    render(<NeedsReviewBadge {...makeProps([RECEIPT_A, RECEIPT_B])} />);

    await user.click(screen.getByRole("button", { name: /email enrichment available/i }));
    await screen.findByRole("dialog");

    expect(screen.getByText("Mercado Pago")).toBeInTheDocument();
    expect(screen.getByText("Rappi SAS")).toBeInTheDocument();
    expect(screen.getByText("PayU")).toBeInTheDocument();
    expect(screen.getByText("Domicilios.com")).toBeInTheDocument();
  });

  it("clicking 'Es este' sends a confirm request with the right body", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    render(<NeedsReviewBadge {...makeProps()} />);
    await user.click(screen.getByRole("button", { name: /email enrichment available/i }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /^es este$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/integrations/gmail/disambiguate");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ transactionId: 42, receiptId: 10, decision: "confirm" });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
  });

  it("clicking 'Ninguno coincide' sends a reject request with the right body", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    render(<NeedsReviewBadge {...makeProps()} />);
    await user.click(screen.getByRole("button", { name: /email enrichment available/i }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /ninguno coincide/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ transactionId: 42, decision: "reject" });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
  });

  it("clicking 'Cancelar' closes without fetching", async () => {
    const user = userEvent.setup();
    render(<NeedsReviewBadge {...makeProps()} />);

    await user.click(screen.getByRole("button", { name: /email enrichment available/i }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /^cancelar$/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an error toast and reopens dialog on fetch error", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    );

    render(<NeedsReviewBadge {...makeProps()} />);
    await user.click(screen.getByRole("button", { name: /email enrichment available/i }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: /^es este$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  });
});
