// #443 — derives a ledger-signed cents value from whatever the user typed in
// the consolidate-form saldo-real input, branching on `BalanceProjection.creditContext`:
//
//   - null (savings/loan/etc.)  → input is ledger-signed positive (legacy).
//   - single-currency TC        → input is Cupo disponible positive; ledger
//                                 = -(limit - cupo).
//   - shared-cupo multi-currency TC → input is Cupo disponible COP positive;
//                                 derives the TARGET sub-account's ledger by
//                                 subtracting sibling debt (COP) and converting
//                                 the remainder back to target currency using
//                                 the provided TRM. Mirrors the server-side
//                                 math in `adjustAccountBalance::sharedAvailableCop`.
//
// Pure function — no DOM / no DB / no React. Unit-testable.

import type { CreditContext } from "@/lib/ingestion/bancolombia-statement/consolidate";

import { parseSignedAmountToCents } from "./parse-saldo-real";

export type DeriveInput = {
  raw: string;
  targetCurrency: "COP" | "USD";
  creditContext: CreditContext | null | undefined;
};

export type DeriveResult =
  | { kind: "empty" }
  | { kind: "invalid"; reason: "parse-failed" | "negative-cupo" | "exceeds-limit" }
  | {
      kind: "ok";
      // Positive cupo (cents, in COP for shared-cupo else native). Undefined
      // when creditContext is null (legacy savings path — input IS the ledger).
      cupoCents: bigint | null;
      // Ledger-signed cents value that the server will receive.
      ledgerCents: bigint;
    };

const ONE_MILLION = BigInt(1_000_000);

// Mirrors src/lib/money.ts::convertCents. Inlined so this helper stays
// framework-free (no "import server" chain pulled into the client bundle).
function convertCents(
  amountCents: bigint,
  from: "COP" | "USD",
  to: "COP" | "USD",
  copPerUsd: number,
): bigint {
  if (from === to) return amountCents;
  const micros = BigInt(Math.round(copPerUsd * 1_000_000));
  if (from === "USD" && to === "COP") {
    return (amountCents * micros) / ONE_MILLION;
  }
  return (amountCents * ONE_MILLION) / micros;
}

export function deriveLedgerFromInput(params: DeriveInput): DeriveResult {
  const parsed = parseSignedAmountToCents(params.raw);
  if (parsed === undefined) return { kind: "empty" };
  if (parsed === null) return { kind: "invalid", reason: "parse-failed" };

  const ctx = params.creditContext ?? null;
  if (ctx === null) {
    return { kind: "ok", cupoCents: null, ledgerCents: parsed };
  }

  if (parsed < BigInt(0)) return { kind: "invalid", reason: "negative-cupo" };

  if (ctx.kind === "single-currency") {
    const limit = BigInt(ctx.creditLimitCentsStr);
    if (parsed > limit) return { kind: "invalid", reason: "exceeds-limit" };
    const ledger = parsed - limit;
    return { kind: "ok", cupoCents: parsed, ledgerCents: ledger };
  }

  const limitCop = BigInt(ctx.creditLimitCopCentsStr);
  const siblingDebtCop = BigInt(ctx.siblingDebtCopCentsStr);
  if (parsed > limitCop) return { kind: "invalid", reason: "exceeds-limit" };
  const totalDebtCop = limitCop - parsed;
  const remainingCop = totalDebtCop - siblingDebtCop;
  const targetDebtCop = remainingCop <= BigInt(0) ? BigInt(0) : remainingCop;
  const targetDebtNative = convertCents(targetDebtCop, "COP", params.targetCurrency, ctx.copPerUsd);
  return { kind: "ok", cupoCents: parsed, ledgerCents: -targetDebtNative };
}

// Convenience: the projected CUPO the user would have AFTER this consolidation
// applies (matching the placeholder shown in the form). Computed from the
// ledger-signed projected saldo:
//   single-currency: cupo = max(0, limit + saldoProyectado)  (saldoProy ≤ 0 → cupo ≤ limit)
//   shared-cupo:     projected target debt (native)       = max(0, -saldoProy)
//                    projected target debt COP            = convert(..., "COP")
//                    projected cupo COP                   = max(0, limit_cop - sibling_debt_cop - target_debt_cop)
// Returns null when creditContext is null (savings/loan — no cupo concept).
export function projectedCupoCents(
  saldoProyectadoLedgerCents: bigint,
  targetCurrency: "COP" | "USD",
  creditContext: CreditContext | null | undefined,
): bigint | null {
  const ctx = creditContext ?? null;
  if (ctx === null) return null;
  if (ctx.kind === "single-currency") {
    const limit = BigInt(ctx.creditLimitCentsStr);
    const cupo = limit + saldoProyectadoLedgerCents;
    return cupo < BigInt(0) ? BigInt(0) : cupo;
  }
  const limitCop = BigInt(ctx.creditLimitCopCentsStr);
  const siblingDebtCop = BigInt(ctx.siblingDebtCopCentsStr);
  const targetDebtNative =
    saldoProyectadoLedgerCents < BigInt(0) ? -saldoProyectadoLedgerCents : BigInt(0);
  const targetDebtCop = convertCents(targetDebtNative, targetCurrency, "COP", ctx.copPerUsd);
  const cupoCop = limitCop - siblingDebtCop - targetDebtCop;
  return cupoCop < BigInt(0) ? BigInt(0) : cupoCop;
}
