// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Hoist mocks above imports so they are available when modules are evaluated.
// Memory: nextjs16-use-server-async-only + vi.hoisted pattern.
// ---------------------------------------------------------------------------

const {
  mockPreviewIngestion,
  mockCommitIngestion,
  mockPreviewArqStatement,
  mockCommitArqStatement,
  mockToastSuccess,
  mockToastError,
  mockToastInfo,
} = vi.hoisted(() => ({
  mockPreviewIngestion: vi.fn(),
  mockCommitIngestion: vi.fn(),
  mockPreviewArqStatement: vi.fn(),
  mockCommitArqStatement: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
}));

vi.mock("@/app/(app)/imports/actions", () => ({
  previewIngestion: mockPreviewIngestion,
  commitIngestion: mockCommitIngestion,
  previewArqStatement: mockPreviewArqStatement,
  commitArqStatement: mockCommitArqStatement,
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError, info: mockToastInfo },
}));

import { StatementUploader } from "./statement-uploader";
import type { AccountOption } from "./statement-uploader";

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

  mockPreviewIngestion.mockReset();
  mockCommitIngestion.mockReset();
  mockPreviewArqStatement.mockReset();
  mockCommitArqStatement.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockToastInfo.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNTS: AccountOption[] = [
  { id: 1, name: "ARQ Savings", currency: "USD", institution: "ARQ" },
  { id: 2, name: "Bancolombia Ahorros", currency: "COP", institution: "Bancolombia" },
];

function makeFakePdf(size: number = 16): File {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x25; // %
  bytes[1] = 0x50; // P
  bytes[2] = 0x44; // D
  bytes[3] = 0x46; // F
  return new File([bytes], "statement.pdf", { type: "application/pdf" });
}

function makeFakeXlsx(): File {
  const bytes = new Uint8Array(16);
  bytes[0] = 0x50; // P
  bytes[1] = 0x4b; // K
  bytes[2] = 0x03; //
  bytes[3] = 0x04; //
  return new File([bytes], "movimientos.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

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

function makeArqPreviewResult(overrides: Partial<{ token: string; accountLabel: string }> = {}) {
  return {
    kind: "arq-pdf" as const,
    token: overrides.token ?? "tok-arq",
    accountLabel: overrides.accountLabel ?? "ARQ Savings (USD)",
    period: { start: "2026-01-01", end: "2026-01-31" },
    parsedCount: 42,
    balanceCheck: {
      ok: true,
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
      chainOk: null as boolean | null,
      previousEndCents: null as string | null,
      currentStartCents: "100000",
      diffCents: null as string | null,
    },
    mergePreview: { parsedCount: 42, estimatedMergeCount: 0 },
    errors: [],
  };
}

function makeSavingsPreviewResult() {
  return {
    kind: "bancolombia-savings" as const,
    token: "tok-savings",
    accountLabel: "Bancolombia Ahorros (COP)",
    period: { start: "2026-01-01", end: "2026-01-31" },
    rowCount: 10,
    matched: 8,
    newInserts: 2,
    nearMatches: 0,
    flaggedExisting: 1,
    fileHash: "abc123",
    multiCurrency: null,
  };
}

function makeFormatUnknownResult() {
  return {
    kind: "format_unknown" as const,
    needsManualKindPick: true as const,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatementUploader", () => {
  it("renders the drop zone and account dropdown", () => {
    render(<StatementUploader accounts={TEST_ACCOUNTS} />);

    expect(screen.getByLabelText(/cuenta/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/zona de carga/i)).toBeInTheDocument();
  });

  it("drops PDF → shows ARQ badge, account dropdown, no cycle input", async () => {
    mockPreviewIngestion.mockResolvedValueOnce(makeArqPreviewResult());

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(mockPreviewIngestion).toHaveBeenCalledTimes(1);
    });

    // Preview block renders ARQ format badge (text "ARQ PDF")
    await waitFor(() => {
      expect(screen.getByText("ARQ PDF")).toBeInTheDocument();
    });

    // No cycle input visible for ARQ
    expect(screen.queryByLabelText(/ciclo/i)).not.toBeInTheDocument();
  });

  it("drops XLSX → shows Bancolombia savings badge", async () => {
    mockPreviewIngestion.mockResolvedValueOnce(makeSavingsPreviewResult());

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakeXlsx());

    await waitFor(() => {
      expect(screen.getByText("Movimientos")).toBeInTheDocument();
    });
  });

  it("shows confirm button and cancel button in preview state (ARQ)", async () => {
    mockPreviewIngestion.mockResolvedValueOnce(makeArqPreviewResult());

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByText("Subir")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /cancelar/i })).toBeInTheDocument();
    });
  });

  it("format_unknown → manual kind picker dropdown rendered", async () => {
    mockPreviewIngestion.mockResolvedValueOnce(makeFormatUnknownResult());

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakeXlsx());

    await waitFor(() => {
      expect(screen.getByText(/formato no reconocido/i)).toBeInTheDocument();
    });
    // Manual kind dropdown visible
    await waitFor(() => {
      expect(screen.getByLabelText(/seleccioná el formato manualmente/i)).toBeInTheDocument();
    });
  });

  it("account override → previewIngestion called again with new hint", async () => {
    mockPreviewIngestion.mockResolvedValue(makeArqPreviewResult());

    const user = userEvent.setup();
    render(<StatementUploader accounts={TEST_ACCOUNTS} />);

    // First drop triggers previewIngestion
    simulateFileSelect(makeFakePdf());
    await waitFor(() => expect(mockPreviewIngestion).toHaveBeenCalledTimes(1));

    // Change account dropdown — should trigger re-preview
    const accountDropdown = screen.getByLabelText(/cuenta/i);
    await user.selectOptions(accountDropdown, "1");
    await waitFor(() => expect(mockPreviewIngestion).toHaveBeenCalledTimes(2));
  });

  it("commit success (ARQ) → success banner shown", async () => {
    const user = userEvent.setup();
    mockPreviewIngestion.mockResolvedValueOnce(makeArqPreviewResult({ token: "tok-success" }));
    mockCommitIngestion.mockResolvedValueOnce({
      kind: "arq-pdf",
      status: "committed",
      importId: 1,
      insertedCount: 30,
      mergedCount: 12,
      flaggedCount: 2,
      emailOrphanCount: 0,
      period: { start: "2026-01-01", end: "2026-01-31" },
    });

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByText("Subir")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Subir"));

    await waitFor(() => {
      expect(screen.getByText(/30 nuevas/i)).toBeInTheDocument();
    });

    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringMatching(/30 nuevas/));
  });

  it("expired token → toast error and reset to idle", async () => {
    const user = userEvent.setup();
    mockPreviewIngestion.mockResolvedValueOnce(makeArqPreviewResult({ token: "tok-old" }));
    mockCommitIngestion.mockResolvedValueOnce({
      kind: "arq-pdf",
      status: "expired",
      error: "La sesión de preview expiró.",
    });

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => expect(screen.getByText("Subir")).toBeInTheDocument());

    await user.click(screen.getByText("Subir"));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/expiró/i));
    });

    // Resets to idle — drop zone visible again
    await waitFor(() => {
      expect(screen.getByLabelText(/zona de carga/i)).toBeInTheDocument();
    });
  });

  it("shows error card when previewIngestion throws", async () => {
    mockPreviewIngestion.mockRejectedValueOnce(new Error("No se pudo procesar el archivo."));

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByText(/no se pudo procesar el archivo/i)).toBeInTheDocument();
    });
  });

  it("resets to idle on cancel", async () => {
    const user = userEvent.setup();
    mockPreviewIngestion.mockResolvedValueOnce(makeArqPreviewResult());

    render(<StatementUploader accounts={TEST_ACCOUNTS} />);
    simulateFileSelect(makeFakePdf());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancelar/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancelar/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/zona de carga/i)).toBeInTheDocument();
      expect(screen.queryByText("Subir")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // #752 — Picker grouping for multi-currency cards
  // ---------------------------------------------------------------------------

  describe("account picker grouping (#752)", () => {
    const MULTI_CURRENCY_ACCOUNTS: AccountOption[] = [
      // Multi-currency Mastercard: COP leg (primary) + USD leg — same physicalCardId
      {
        id: 10,
        name: "Bancolombia Mastercard *7291",
        currency: "COP",
        institution: "Bancolombia",
        physicalCardId: "pc-7291",
      },
      {
        id: 11,
        name: "Bancolombia Mastercard *7291",
        currency: "USD",
        institution: "Bancolombia",
        physicalCardId: "pc-7291",
      },
      // Single-currency Visa (no physicalCardId) — shows with currency suffix
      {
        id: 20,
        name: "Bancolombia Visa *2575",
        currency: "COP",
        institution: "Bancolombia",
      },
      // Savings — no physicalCardId
      {
        id: 30,
        name: "Bancolombia Ahorros",
        currency: "COP",
        institution: "Bancolombia",
      },
    ];

    it("renders ONE option for a multi-currency card instead of two", () => {
      render(<StatementUploader accounts={MULTI_CURRENCY_ACCOUNTS} />);

      const dropdown = screen.getByLabelText(/cuenta/i);
      const options = dropdown.querySelectorAll("option");

      // Blank + 1 grouped card + 1 Visa + 1 Ahorros = 4 total (NOT 5)
      expect(options).toHaveLength(4);
    });

    it("grouped card option has no currency suffix in its label", () => {
      render(<StatementUploader accounts={MULTI_CURRENCY_ACCOUNTS} />);

      const dropdown = screen.getByLabelText(/cuenta/i);
      const options = Array.from(dropdown.querySelectorAll("option"));

      const mastercard = options.find((o) => o.textContent?.includes("*7291"));
      expect(mastercard).toBeTruthy();
      // Must NOT contain "(COP)" or "(USD)" suffix
      expect(mastercard!.textContent).not.toMatch(/\(COP\)|\(USD\)/);
    });

    it("single-currency card renders with currency suffix via formatAccountLabel", () => {
      render(<StatementUploader accounts={MULTI_CURRENCY_ACCOUNTS} />);

      const dropdown = screen.getByLabelText(/cuenta/i);
      const options = Array.from(dropdown.querySelectorAll("option"));

      const visa = options.find((o) => o.textContent?.includes("*2575"));
      expect(visa).toBeTruthy();
      expect(visa!.textContent).toContain("(COP)");
    });

    it("grouped option value is the COP leg account_id", () => {
      render(<StatementUploader accounts={MULTI_CURRENCY_ACCOUNTS} />);

      const dropdown = screen.getByLabelText(/cuenta/i);
      const options = Array.from(dropdown.querySelectorAll("option"));

      const mastercard = options.find((o) => o.textContent?.includes("*7291"));
      expect(mastercard).toBeTruthy();
      // COP leg is id=10; USD leg is id=11 — value must be the COP leg
      expect(mastercard!.getAttribute("value")).toBe("10");
    });

    it("selecting the grouped option calls previewIngestion with the COP leg account_id", async () => {
      mockPreviewIngestion.mockResolvedValue(makeArqPreviewResult());

      const user = userEvent.setup();
      render(<StatementUploader accounts={MULTI_CURRENCY_ACCOUNTS} />);

      // Drop a file first so re-preview fires on account change
      simulateFileSelect(makeFakePdf());
      await waitFor(() => expect(mockPreviewIngestion).toHaveBeenCalledTimes(1));

      // Select the grouped Mastercard option
      const dropdown = screen.getByLabelText(/cuenta/i);
      await user.selectOptions(dropdown, "10");

      await waitFor(() => expect(mockPreviewIngestion).toHaveBeenCalledTimes(2));

      // The second call's FormData should contain hint_account_id = "10"
      const secondCallFormData = mockPreviewIngestion.mock.calls[1][0] as FormData;
      expect(secondCallFormData.get("hint_account_id")).toBe("10");
    });

    it("single-member group (sibling archived) renders as ONE option with no currency suffix", () => {
      // Only the USD leg exists — the COP sibling was archived. The grouping
      // path still fires (physicalCardId is set) and should collapse to one entry
      // with no "(USD)" suffix, because the xlsx covers whatever currency is present.
      const ORPHAN_LEG: AccountOption[] = [
        {
          id: 11,
          name: "Bancolombia Mastercard *7291",
          currency: "USD",
          institution: "Bancolombia",
          physicalCardId: "pc-7291",
        },
      ];

      render(<StatementUploader accounts={ORPHAN_LEG} />);

      const dropdown = screen.getByLabelText(/cuenta/i);
      const options = Array.from(dropdown.querySelectorAll("option"));

      // Blank + 1 grouped entry = 2 (NOT 3 by treating it as a bare single)
      expect(options).toHaveLength(2);

      const card = options.find((o) => o.textContent?.includes("*7291"));
      expect(card).toBeTruthy();
      // physicalCardId is set → no currency suffix appended
      expect(card!.textContent).not.toMatch(/\(USD\)|\(COP\)/);
    });
  });
});
