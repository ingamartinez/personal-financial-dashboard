// Sibling types file — no "use server" directive.
// All types that were previously exported from actions.ts live here.
// actions.ts imports them with `import type` and re-exports where needed.
// See AGENTS.md and engram nextjs16-server-action-types-split for the pattern.

// ---------------------------------------------------------------------------
// AccountUpsertInput
// ---------------------------------------------------------------------------

type MetadataSide = {
  last4s?: string[];
  network?: "visa" | "mastercard" | "amex";
  creditLimitCents?: number;
  cutoffDay?: number;
  interestRateMonthly?: number;
  termMonths?: number;
  loanOriginalCents?: number;
  loanRemainingCents?: number;
  monthlyPaymentCents?: number;
  creditRateBuckets?: {
    oneMonth: number;
    months2to36: number;
    advances: number;
  };
};

type AccountSide = {
  currency: "COP" | "USD";
  balance: number | string;
  metadata?: MetadataSide;
};

type PhysicalCardInput = {
  name?: string;
  creditLimitCents?: number;
  cutoffDay?: number;
  last4?: string;
  network?: "visa" | "mastercard" | "amex";
};

export type AccountUpsertInput = {
  id?: number | string;
  name: string;
  institutionSlug: string;
  institution?: string;
  type: "savings" | "credit_card" | "loan";
  active?: boolean | string;
  primary: AccountSide;
  secondary?: AccountSide;
  physicalCard?: PhysicalCardInput;
};

// ---------------------------------------------------------------------------
// UpsertAccountResult
// ---------------------------------------------------------------------------

export type UpsertAccountResult =
  | { ok: true; propagatedToSiblings: number }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// UpdatePhysicalCardInput
// ---------------------------------------------------------------------------

export type UpdatePhysicalCardInput = {
  id: string;
  name?: string | null;
  creditLimitCents?: number | string;
  statementCutoffDay?: number | string | null;
  last4?: string | null;
  network?: "visa" | "mastercard" | "amex" | null;
};

// ---------------------------------------------------------------------------
// AdjustBalanceInput
// ---------------------------------------------------------------------------

type DeclaredBalance =
  | { kind: "balance"; balanceCents: number | string }
  | { kind: "availableCredit"; availableCreditCents: number | string }
  | { kind: "sharedAvailableCop"; availableCopCents: number | string }
  | {
      kind: "perCurrencyDualDebt";
      debtCopCents?: number | string;
      debtUsdCents?: number | string;
    };

export type AdjustBalanceInput = {
  accountId: number | string;
  declared: DeclaredBalance;
  reason?: string;
};

// ---------------------------------------------------------------------------
// AdjustBalanceResult
// ---------------------------------------------------------------------------

export type AdjustBalanceResult =
  | { status: "ok"; diffCents: string; txId: number }
  // #447 — dual-debt commit returns one entry per sub-account (ordered
  // primary-then-sibling) so the UI can surface both diffs in a single toast.
  | {
      status: "ok_dual";
      results: Array<{
        accountId: number;
        currency: "COP" | "USD";
        diffCents: string;
        txId: number;
      }>;
    }
  | { status: "noop" }
  | { status: "error"; message: string };
