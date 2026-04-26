// ARQ statement type handlers.
//
// Transforms each RawTxLine (from the PDF adapter) into a domain-level
// ParsedStatementTx. Pure function — no DB access, no side effects.
//
// One handler per raw type string. Unknown types yield a "skip" result so that
// forward-compat with new ARQ transaction types never throws.

import { createHash } from "node:crypto";

import { createLogger } from "@/lib/logger";

import type { RawStatement, RawTxLine } from "./types";

const log = createLogger({ module: "arq-statement-type-handlers" });

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

interface BaseTx {
  occurredAt: Date;
  /** Signed amount in USDc cents. Negative = debit, positive = credit. */
  amountUsdc: bigint;
  externalIdPrefix: "arq-stmt";
  externalId: string;
}

export interface PurchaseTx extends BaseTx {
  kind: "purchase";
  merchant: string;
  originalCurrency: "COP" | "USD";
  /** Absolute cents in the original currency. */
  originalAmount: bigint;
  /**
   * Frozen TRM at the time of the transaction (COP per USDc).
   * null for USD-denominated purchases (USD ≈ USDc, no conversion).
   */
  trmCopPerUsdc: number | null;
}

export interface TransferSentTx extends BaseTx {
  kind: "transfer_sent";
  originalCurrency: "COP";
  /** Absolute COP cents sent. */
  originalAmount: bigint;
  recipientName: string;
  /** Frozen TRM: COP per USDc at the time of sale. */
  trmCopPerUsdc: number;
}

export interface TransferReceivedTx extends BaseTx {
  kind: "transfer_received";
  originalCurrency: "USD";
  /** Absolute USD cents received (1:1 with USDc). */
  originalAmount: bigint;
  counterparty: string;
  /** Always null — USD ↔ USDc is 1:1 inside ARQ. */
  trmCopPerUsdc: null;
}

export interface P2PTransferTx extends BaseTx {
  kind: "p2p_transfer";
  originalCurrency: "USDc" | "COP";
  /** Absolute cents in the original currency. */
  originalAmount: bigint;
  /**
   * counterparty for USDc-pure P2P (intra-ARQ).
   * recipientName for COP P2P (off-ramp style).
   */
  counterparty: string;
}

export interface FeeTx extends BaseTx {
  kind: "fee";
  feeKind: "subscription" | "other";
  description: string;
}

export interface RewardTx extends BaseTx {
  kind: "reward";
  rewardKind: "cashback" | "monthly_benefit";
  description: string;
}

export type ParsedStatementTx =
  | PurchaseTx
  | TransferSentTx
  | TransferReceivedTx
  | P2PTransferTx
  | FeeTx
  | RewardTx
  | { kind: "skip"; reason: string; raw: RawTxLine };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a counterparty or merchant string: trim leading/trailing
 * whitespace and collapse internal runs of whitespace to a single space.
 */
function normalise(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Build a deterministic externalId for a raw transaction line.
 *
 * Inputs:
 *   - accountNumber (from statement header)
 *   - periodStart ISO string
 *   - lineIndex (0-based position in the transaction list)
 *   - raw type string
 *   - raw amountCents (as string)
 *   - raw description
 *
 * Output: hex-encoded SHA-256 truncated to 24 chars.
 *
 * Idempotency invariant: same RawTxLine + same period → same externalId
 * across runs and across re-imports of the same statement.
 */
function buildExternalId(
  accountNumber: string,
  periodStart: Date,
  lineIndex: number,
  raw: RawTxLine,
): string {
  const digest = createHash("sha256")
    .update(accountNumber)
    .update("|")
    .update(periodStart.toISOString())
    .update("|")
    .update(String(lineIndex))
    .update("|")
    .update(raw.type)
    .update("|")
    .update(String(raw.amountCents))
    .update("|")
    .update(raw.description)
    .digest("hex");

  return digest.slice(0, 24);
}

/**
 * Calculate TRM (COP per USDc) from raw cents.
 *
 * Both inputs are in cents so they cancel — the ratio is the same as
 * whole-units. For example:
 *   originalAmountCents = 6_744_000  (COP 67,440.00 = 674,400,00 centavos)
 *   amountUsdcCents     = 1_803      (USDc 18.03)
 *   → 6_744_000 / 1_803 ≈ 3_741.54 COP per USDc
 *
 * Uses absolute values because both figures carry sign.
 */
function calcTrm(originalAmountCents: bigint, amountUsdcCents: bigint): number {
  if (amountUsdcCents === BigInt(0)) return 0;
  return Number(originalAmountCents < BigInt(0) ? -originalAmountCents : originalAmountCents) /
    Number(amountUsdcCents < BigInt(0) ? -amountUsdcCents : amountUsdcCents);
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

function handlePagoConTarjeta(
  raw: RawTxLine,
  base: BaseTx,
): PurchaseTx | { kind: "skip"; reason: string; raw: RawTxLine } {
  const currency = raw.equivalentCurrency;

  if (currency === "COP") {
    if (raw.equivalentAmountCents === null) {
      return {
        kind: "skip",
        reason: "Pago con tarjeta COP: equivalentAmountCents is null",
        raw,
      };
    }
    return {
      ...base,
      kind: "purchase",
      merchant: normalise(raw.description),
      originalCurrency: "COP",
      originalAmount:
        raw.equivalentAmountCents < BigInt(0) ? -raw.equivalentAmountCents : raw.equivalentAmountCents,
      trmCopPerUsdc: calcTrm(raw.equivalentAmountCents, raw.amountCents),
    };
  }

  if (currency === "USD") {
    // USD-direct purchase (international / digital): 1:1 with USDc amount.
    const equiv =
      raw.equivalentAmountCents !== null
        ? raw.equivalentAmountCents < BigInt(0)
          ? -raw.equivalentAmountCents
          : raw.equivalentAmountCents
        : raw.amountCents < BigInt(0)
          ? -raw.amountCents
          : raw.amountCents;

    return {
      ...base,
      kind: "purchase",
      merchant: normalise(raw.description),
      originalCurrency: "USD",
      originalAmount: equiv,
      trmCopPerUsdc: null,
    };
  }

  return {
    kind: "skip",
    reason: `Pago con tarjeta: unexpected equivalentCurrency "${String(currency)}"`,
    raw,
  };
}

function handleCompraUsdc(
  raw: RawTxLine,
  base: BaseTx,
): TransferReceivedTx | { kind: "skip"; reason: string; raw: RawTxLine } {
  if (raw.equivalentCurrency !== "USD") {
    return {
      kind: "skip",
      reason: `Compra USDc: expected USD equivalentCurrency, got "${String(raw.equivalentCurrency)}"`,
      raw,
    };
  }

  const equiv =
    raw.equivalentAmountCents !== null
      ? raw.equivalentAmountCents < BigInt(0)
        ? -raw.equivalentAmountCents
        : raw.equivalentAmountCents
      : raw.amountCents < BigInt(0)
        ? -raw.amountCents
        : raw.amountCents;

  return {
    ...base,
    kind: "transfer_received",
    originalCurrency: "USD",
    originalAmount: equiv,
    counterparty: normalise(raw.description),
    trmCopPerUsdc: null,
  };
}

function handleVentaUsdc(
  raw: RawTxLine,
  base: BaseTx,
): TransferSentTx | { kind: "skip"; reason: string; raw: RawTxLine } {
  if (raw.equivalentCurrency !== "COP") {
    return {
      kind: "skip",
      reason: `Venta USDc: expected COP equivalentCurrency, got "${String(raw.equivalentCurrency)}"`,
      raw,
    };
  }
  if (raw.equivalentAmountCents === null) {
    return { kind: "skip", reason: "Venta USDc: equivalentAmountCents is null", raw };
  }

  return {
    ...base,
    kind: "transfer_sent",
    originalCurrency: "COP",
    originalAmount:
      raw.equivalentAmountCents < BigInt(0) ? -raw.equivalentAmountCents : raw.equivalentAmountCents,
    recipientName: normalise(raw.description),
    trmCopPerUsdc: calcTrm(raw.equivalentAmountCents, raw.amountCents),
  };
}

function handleTransferenciaP2P(
  raw: RawTxLine,
  base: BaseTx,
): P2PTransferTx | { kind: "skip"; reason: string; raw: RawTxLine } {
  const currency = raw.equivalentCurrency;

  if (currency === "USDc") {
    // Intra-ARQ P2P: amount and equivalent are the same (USDc ↔ USDc).
    const equiv =
      raw.equivalentAmountCents !== null
        ? raw.equivalentAmountCents < BigInt(0)
          ? -raw.equivalentAmountCents
          : raw.equivalentAmountCents
        : raw.amountCents < BigInt(0)
          ? -raw.amountCents
          : raw.amountCents;

    return {
      ...base,
      kind: "p2p_transfer",
      originalCurrency: "USDc",
      originalAmount: equiv,
      counterparty: normalise(raw.description),
    };
  }

  if (currency === "COP") {
    if (raw.equivalentAmountCents === null) {
      return { kind: "skip", reason: "Transferencia P2P COP: equivalentAmountCents is null", raw };
    }

    return {
      ...base,
      kind: "p2p_transfer",
      originalCurrency: "COP",
      originalAmount:
        raw.equivalentAmountCents < BigInt(0) ? -raw.equivalentAmountCents : raw.equivalentAmountCents,
      counterparty: normalise(raw.description),
    };
  }

  return {
    kind: "skip",
    reason: `Transferencia P2P: unexpected equivalentCurrency "${String(currency)}"`,
    raw,
  };
}

function handleComision(raw: RawTxLine, base: BaseTx): FeeTx {
  const feeKind: "subscription" | "other" = /DolarApp subscription/i.test(raw.description)
    ? "subscription"
    : "other";

  return {
    ...base,
    kind: "fee",
    feeKind,
    description: normalise(raw.description),
  };
}

function handleCashback(raw: RawTxLine, base: BaseTx): RewardTx {
  return {
    ...base,
    kind: "reward",
    rewardKind: "cashback",
    description: normalise(raw.description),
  };
}

function handleBeneficio(raw: RawTxLine, base: BaseTx): RewardTx {
  return {
    ...base,
    kind: "reward",
    rewardKind: "monthly_benefit",
    description: normalise(raw.description),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function dispatchLine(
  raw: RawTxLine,
  accountNumber: string,
  periodStart: Date,
  lineIndex: number,
): ParsedStatementTx {
  const externalId = buildExternalId(accountNumber, periodStart, lineIndex, raw);

  const base: BaseTx = {
    occurredAt: raw.date,
    amountUsdc: raw.amountCents,
    externalIdPrefix: "arq-stmt",
    externalId,
  };

  switch (raw.type) {
    case "Pago con tarjeta":
      return handlePagoConTarjeta(raw, base);

    case "Compra USDc":
      return handleCompraUsdc(raw, base);

    case "Venta USDc":
      return handleVentaUsdc(raw, base);

    case "Transferencia P2P":
      return handleTransferenciaP2P(raw, base);

    case "Comisión":
      return handleComision(raw, base);

    case "Cashback":
      return handleCashback(raw, base);

    case "Beneficio":
      return handleBeneficio(raw, base);

    default: {
      log.warn(
        {
          event: "arq_type_handler_unknown",
          rawType: raw.type,
          lineIndex,
          accountNumber,
        },
        "unknown ARQ transaction type — skipping",
      );
      return {
        kind: "skip",
        reason: `Unknown transaction type: "${raw.type}"`,
        raw,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transform all raw transaction lines in a `RawStatement` into
 * `ParsedStatementTx[]`.
 *
 * - Each of the 9 known ARQ types has a dedicated handler.
 * - Unknown types yield `{ kind: "skip", reason, raw }` — never throw.
 * - Callers (e.g. the #517 reconciler) may filter skips or surface them for
 *   review.
 *
 * @param raw - The parsed statement as returned by the PDF adapter (#513).
 * @returns Array with one entry per raw transaction; skips are included.
 */
export function parseStatementTransactions(raw: RawStatement): ParsedStatementTx[] {
  const { accountNumber, periodStart } = raw.header;

  log.debug(
    {
      event: "arq_type_handlers_start",
      accountNumber,
      periodStart: periodStart.toISOString(),
      txCount: raw.transactions.length,
    },
    "dispatching raw transaction lines to type handlers",
  );

  const results = raw.transactions.map((line, idx) =>
    dispatchLine(line, accountNumber, periodStart, idx),
  );

  const skipped = results.filter((r) => r.kind === "skip").length;

  if (skipped > 0) {
    log.warn(
      {
        event: "arq_type_handlers_skipped",
        skipped,
        total: results.length,
        accountNumber,
      },
      "some transaction lines were skipped — review needed",
    );
  }

  log.debug(
    {
      event: "arq_type_handlers_done",
      total: results.length,
      skipped,
      accountNumber,
    },
    "type handler dispatch complete",
  );

  return results;
}
