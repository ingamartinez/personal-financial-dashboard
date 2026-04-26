// ARQ statement parser — shared types.
//
// Parser output is deliberately DB-agnostic: returns what the PDF says, nothing
// more. Tenant validation, dedup, and persistence are handled by later
// sub-issues (#517 reconciler, #514 type handlers).

export type ArqEquivalentCurrency = "COP" | "USD" | "USDc";

// All 9 raw type strings as they appear verbatim in the "Tipo" column of an
// ARQ statement PDF. #514 will map these to domain-level kinds.
export type ArqRawType =
  | "Pago con tarjeta"
  | "Compra USDc"
  | "Venta USDc"
  | "Transferencia P2P"
  | "Comisión"
  | "Cashback"
  | "Beneficio"
  | string; // catch-all: forward-compat with new types the user hasn't seen

export interface RawTxLine {
  /** Calendar date within the statement period. Year resolved from header. */
  date: Date;
  /** Raw value from the "Tipo" column — e.g. "Pago con tarjeta". */
  type: string;
  /**
   * Signed amount in USDc cents. This is the "Monto" column — always
   * USDc-denominated (USD and USDc are 1:1 internally inside ARQ).
   * Negative = debit, positive = credit.
   */
  amountCents: bigint;
  /**
   * Currency of the "Moneda Local Equivalente" column.
   * null when the column reads "N/A" (Comisión, Beneficio rows).
   */
  equivalentCurrency: ArqEquivalentCurrency | null;
  /**
   * Equivalent amount in the foreign currency, in cents (same sign as
   * amountCents). null when equivalentCurrency is null.
   */
  equivalentAmountCents: bigint | null;
  /** Counterparty or merchant description — multi-line rows are re-joined. */
  description: string;
}

export interface RawStatementSummary {
  /** Opening balance in USDc cents. */
  balanceStartCents: bigint;
  /** Sum of all credits in USDc cents (positive). */
  totalCreditsCents: bigint;
  /** Sum of all debits in USDc cents (absolute value, positive). */
  totalDebitsCents: bigint;
  /** Closing balance in USDc cents. */
  balanceEndCents: bigint;
}

export interface RawStatementHeader {
  /** Full legal name from the PDF header, e.g. "ALEJANDRO RAFAEL MARTINEZ MALDONADO". */
  accountHolder: string;
  /** ARQ account number (US account), e.g. "211215197073". */
  accountNumber: string;
  /** ACH routing number, e.g. "101019644". */
  routingNumber: string;
  /** First day of the statement period (inclusive). */
  periodStart: Date;
  /** Last day of the statement period (inclusive). */
  periodEnd: Date;
  /** Number of calendar days in the period. */
  durationDays: number;
  summary: RawStatementSummary;
}

export interface RawStatement {
  header: RawStatementHeader;
  transactions: RawTxLine[];
}
