// Bancolombia .xlsx credit-card statement parser — shared types.
//
// The parser output is deliberately DB-agnostic: it just represents what the
// extracto file says. Matching against `transactions` rows and persistence is
// a separate concern (see sub-issue #415 B2).

export type StatementCurrency = "COP" | "USD";

// Statements split movements into two tables:
//   - "Movimientos durante el periodo": compras + pagos del ciclo actual.
//   - "Movimientos antes del periodo": compras viejas aún pagándose a cuotas.
export type StatementKind = "during-period" | "before-period";

export type StatementAccount = {
  last4: string;
  currency: StatementCurrency;
};

export type StatementPeriod = {
  startDate: Date;
  endDate: Date;
  dueDate: Date;
};

export type StatementSummary = {
  previousBalanceCents: bigint;
  purchasesCents: bigint;
  interestCorrientesCents: bigint;
  paymentsCents: bigint;
  minPaymentCents: bigint;
  totalPaymentCents: bigint;
  // Cycle-end balance ("Pago total" on the XLSX — the amount the bank says
  // you owe at end of cycle). Equals totalPaymentCents in the Bancolombia
  // extracto format (both come from the same "Pago total" row). Persisted
  // as balance_at_end_cents on statement_imports for backfill use (#562).
  currentBalanceCents: bigint;
};

// Rates are stored as EM (mes vencido) × 10_000 per project convention
// (see memory `tc-installments-interest-model.md` — rate 19110 = 1.9110% EM).
export type StatementRates = {
  oneMonth: number;
  months2to36: number;
  advances: number;
};

export type StatementInstallments = {
  paid: number;
  total: number;
};

export type StatementRow = {
  kind: StatementKind;
  // null for rows without auth number (e.g. the synthetic INTERESES CORRIENTES
  // line the bank itself inserts at cycle cut).
  authorizationNumber: string | null;
  occurredAt: Date;
  merchant: string;
  // Sign convention: purchase/charge positive, payment/credit negative — this
  // matches what the extracto prints in column "Valor Movimiento".
  amountCents: bigint;
  installments: StatementInstallments | null;
  installmentValueCents: bigint | null;
  rateEmX10k: number | null;
  saldoPendingCents: bigint;
};

export type ParsedStatement = {
  account: StatementAccount;
  period: StatementPeriod;
  summary: StatementSummary;
  currentRates: StatementRates;
  rows: StatementRow[];
};
