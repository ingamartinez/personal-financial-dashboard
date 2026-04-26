// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoist mocks above imports so they are available when modules are evaluated.
// Memory: nextjs16-use-server-async-only + vi.hoisted pattern.
// ---------------------------------------------------------------------------

const { mockPreviewArqStatement, mockCommitArqStatement, mockToastSuccess, mockToastError } =
  vi.hoisted(() => ({
    mockPreviewArqStatement: vi.fn(),
    mockCommitArqStatement: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  }));

vi.mock("@/app/(app)/imports/actions", () => ({
  previewArqStatement: mockPreviewArqStatement,
  commitArqStatement: mockCommitArqStatement,
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import { StatementUploader } from "./statement-uploader";

// ---------------------------------------------------------------------------
// Radix shims for jsdom (pointer-capture + scrollIntoView).
// Pattern from quick-entry-dialog.test.tsx.
// ---------------------------------------------------------------------------

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

  mockPreviewArqStatement.mockReset();
  mockCommitArqStatement.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakePdf(size: number = 16): File {
  // Buffer with %PDF magic bytes
  const bytes = new Uint8Array(size);
  bytes[0] = 0x25; // %
  bytes[1] = 0x50; // P
  bytes[2] = 0x44; // D
  bytes[3] = 0x46; // F
  return new File([bytes], "statement.pdf", { type: "application/pdf" });
}

/**
 * Simulate selecting a file via the hidden file input.
 *
 * `userEvent.upload()` fails in jsdom when the input is `sr-only` (aria-hidden)
 * because jsdom's FileList doesn't implement `item()` via the same shim.
 * We construct a FileList-compatible duck-type and fire a native change event.
 */
function simulateFileSelect(file: File): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  if (!input) throw new Error("file input not found");

  const fileList = {
    0: file,
    length: 1,
    item: (i: number) => (i === 0 ? file : null),
    [Symbol.iterator]: function* () {
      yield file;
    },
  };
  Object.defineProperty(input, "files", { value: fileList, configurable: true });
  fireEvent.change(input);
}

function makePreviewResult(
  overrides: Partial<{
    token: string;
    accountLabel: string;
    parsedCount: number;
    balanceOk: boolean;
  }> = {},
) {
  return {
    token: overrides.token ?? "tok-abc",
    accountLabel: overrides.accountLabel ?? "ARQ Savings (USD)",
    period: { start: "2026-01-01", end: "2026-01-31" },
    parsedCount: overrides.parsedCount ?? 42,
    balanceCheck: {
      ok: overrides.balanceOk ?? true,
      declaredStartCents: "100000",
      declaredEndCents: "120000",
      declaredCreditsCents: "50000",
      declaredDebitsCents: "30000",
      parsedSumCents: "20000",
      diffCents: "0",
      errors: [],
      warnings: [],
    },
    chainCheck: {
      chainOk: null,
      previousEndCents: null,
      currentStartCents: "100000",
      diffCents: null,
    },
    mergePreview: { parsedCount: 42, estimatedMergeCount: 0 },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatementUploader", () => {
  it("renders the drop zone and format selector", () => {
    render(<StatementUploader />);

    expect(screen.getByLabelText(/tipo de extracto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/zona de carga/i)).toBeInTheDocument();
    expect(screen.getByText(/ARQ \/ DolarApp/i)).toBeInTheDocument();
  });

  it("calls previewArqStatement when a file is selected", async () => {
    mockPreviewArqStatement.mockResolvedValueOnce(makePreviewResult());

    render(<StatementUploader />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(mockPreviewArqStatement).toHaveBeenCalledTimes(1);
    });

    // Preview block renders account label and tx count
    await waitFor(() => {
      expect(screen.getByText("ARQ Savings (USD)")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
    });
  });

  it("shows confirm and cancel buttons in preview state", async () => {
    mockPreviewArqStatement.mockResolvedValueOnce(makePreviewResult());

    render(<StatementUploader />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirmar import/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /cancelar/i })).toBeInTheDocument();
    });
  });

  it("confirm button is disabled while committing (pending state)", async () => {
    const user = userEvent.setup();
    mockPreviewArqStatement.mockResolvedValueOnce(makePreviewResult({ token: "tok-123" }));

    // commitArqStatement never resolves — simulates the pending transition.
    mockCommitArqStatement.mockImplementationOnce(() => new Promise(() => {}));

    render(<StatementUploader />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirmar import/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /confirmar import/i }));

    // While confirming: confirm button gone, cancel button disabled.
    await waitFor(() => {
      const cancelBtn = screen.getByRole("button", { name: /cancelar/i });
      expect(cancelBtn).toBeDisabled();
    });
  });

  it("shows success card with counts after commit", async () => {
    const user = userEvent.setup();
    mockPreviewArqStatement.mockResolvedValueOnce(makePreviewResult({ token: "tok-success" }));
    mockCommitArqStatement.mockResolvedValueOnce({
      status: "committed",
      importId: 1,
      insertedCount: 30,
      mergedCount: 12,
      flaggedCount: 2,
      emailOrphanCount: 0,
      period: { start: "2026-01-01", end: "2026-01-31" },
    });

    render(<StatementUploader />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirmar import/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /confirmar import/i }));

    await waitFor(() => {
      expect(screen.getByText(/30 nuevas/i)).toBeInTheDocument();
      expect(screen.getByText(/12 mergeadas/i)).toBeInTheDocument();
    });

    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringMatching(/30 nuevas.*12 mergeadas/));
  });

  it("shows error card when previewArqStatement throws", async () => {
    mockPreviewArqStatement.mockRejectedValueOnce(
      new Error("Este extracto no corresponde a ninguna cuenta tuya."),
    );

    render(<StatementUploader />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByText(/no corresponde a ninguna cuenta tuya/i)).toBeInTheDocument();
    });
  });

  it("resets to idle state on cancel", async () => {
    const user = userEvent.setup();
    mockPreviewArqStatement.mockResolvedValueOnce(makePreviewResult());

    render(<StatementUploader />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancelar/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancelar/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/zona de carga/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /confirmar import/i })).not.toBeInTheDocument();
    });
  });

  it("validates client-side: file too large does not call action", async () => {
    render(<StatementUploader />);

    // Create a file > 10 MB
    const bigBytes = new Uint8Array(11 * 1024 * 1024);
    bigBytes[0] = 0x25;
    bigBytes[1] = 0x50;
    bigBytes[2] = 0x44;
    bigBytes[3] = 0x46;
    const bigFile = new File([bigBytes], "big.pdf", { type: "application/pdf" });

    simulateFileSelect(bigFile);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/supera el límite/i)).toBeInTheDocument();
    });

    expect(mockPreviewArqStatement).not.toHaveBeenCalled();
  });

  it("shows expired toast and resets when commit returns expired", async () => {
    const user = userEvent.setup();
    mockPreviewArqStatement.mockResolvedValueOnce(makePreviewResult({ token: "tok-old" }));
    mockCommitArqStatement.mockResolvedValueOnce({
      status: "expired",
      error: "La sesión de preview expiró. Subí el PDF nuevamente.",
    });

    render(<StatementUploader />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirmar import/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /confirmar import/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/sesión expiró/i));
    });

    // Should reset to idle — drop zone visible again
    await waitFor(() => {
      expect(screen.getByLabelText(/zona de carga/i)).toBeInTheDocument();
    });
  });
});
