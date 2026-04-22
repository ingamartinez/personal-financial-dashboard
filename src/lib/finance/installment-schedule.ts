// #407: pure helper that builds the full installment schedule for a credit-
// card purchase. Input is a single tx (amount + rate + plan); output is a
// row per period with capital / interest / balance, plus headline totals.
//
// Rules, per parent #345 + scoped validations against real Bancolombia
// extracts (ver memoria `tc-installments-interest-model`):
//
//   - regla 4: when `graceMonth=true`, month 1 pays ONLY capital (interest
//     is deferred). Month 2 pays its own interest PLUS the deferred month-1
//     interest. "Francés puro" does NOT apply here.
//   - regla 5: capital per period is `amountCents / N`, fixed, with the
//     final period absorbing the rounding residue. Interest is a separate
//     line per period, never bundled into capital.
//   - regla 3: the rate snapshot lives on the tx — this helper takes it as
//     input and does NOT look it up (the caller resolves bucket vs override
//     via `resolveBucketRateX10k`).
//
// Rounding: interest is computed as `round(saldo × rateEmX10k / 1_000_000)`
// in integer cents, half-up. Matches Bancolombia's display policy close
// enough to pass the extract-level tests in the sibling test file. If a
// future extract diverges, update the policy here — do NOT let the helper
// drift silently.

import type { Currency } from "@/lib/types";
import { EM_X10K_PER_FRACTIONAL } from "./rates";

export type InstallmentScheduleInput = {
  amountCents: bigint; // original purchase amount (positive magnitude)
  rateEmX10k: number; // EM rate stored as percent × 10000 (0 = 0%, 19110 = 1.9110% EM)
  installments: number; // total cuotas, N >= 1
  graceMonth: boolean; // true = month-1 interest deferred to month 2
  purchaseDate: Date; // anchor for month counting
  today: Date; // drives paid vs pending split
};

export type InstallmentScheduleRow = {
  month: number; // 1..N
  capitalCents: bigint;
  interestCents: bigint; // 0 for month 1 when graceMonth=true
  deferredInterestCents: bigint; // 0 except for month 2 when graceMonth=true
  cuotaCents: bigint; // capital + interest + deferred
  balanceAfterCents: bigint; // never negative, hits 0 at month N
};

export type InstallmentScheduleOutput = {
  rows: InstallmentScheduleRow[];
  paidCount: number;
  pendingCount: number;
  // Sum of `cuotaCents` / N. Informational; the actual cuotas are not
  // uniform once interest enters the picture (only capital is uniform).
  monthlyPaymentCents: bigint;
  totalInterestCents: bigint;
  outstandingBalanceCents: bigint;
  outstandingInterestCents: bigint;
  // Optional currency passthrough so consumers that carry through to
  // Money components don't have to re-thread it.
  currency?: Currency;
};

// Round-half-up integer division for `numerator / denominator`. Works on
// BigInt. Positive inputs only; negatives would break the half-up bias.
function bigIntRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) throw new Error("denominator must be > 0");
  return (numerator + denominator / BigInt(2)) / denominator;
}

// Interest for a single period, given a starting balance and the stored
// EM rate (percent × 10000). Split out so tests can drive it directly when
// checking specific rows.
export function periodInterestCents(balanceCents: bigint, rateEmX10k: number): bigint {
  if (rateEmX10k === 0) return BigInt(0);
  if (balanceCents <= BigInt(0)) return BigInt(0);
  return bigIntRoundHalfUp(balanceCents * BigInt(rateEmX10k), BigInt(EM_X10K_PER_FRACTIONAL));
}

export function installmentSchedule(input: InstallmentScheduleInput): InstallmentScheduleOutput {
  const { amountCents, rateEmX10k, installments, graceMonth, purchaseDate, today } = input;
  if (installments < 1) throw new Error("installments must be >= 1");
  if (installments > 240) throw new Error("installments > 240 not supported");
  if (rateEmX10k < 0) throw new Error("rateEmX10k must be >= 0");
  if (amountCents <= BigInt(0)) throw new Error("amountCents must be > 0");

  const N = installments;
  // Capital per period is floored to whole PESOS (multiples of 100 cents) so
  // Σ(capital) matches what Bancolombia prints on the extract. The last row
  // absorbs the residue. This is the policy the real 2026 Visa/Mastercard +
  // Amex-compra-de-cartera extracts use; see `.private/statements/…` for
  // the source data. If `amountCents % 100 !== 0` (non-whole-peso input),
  // the final row still absorbs the full residue — but that shape isn't
  // produced by any real TC purchase we model today.
  const PESO = BigInt(100);
  const capitalPerPeriod = (amountCents / BigInt(N) / PESO) * PESO;
  const residueCents = amountCents - capitalPerPeriod * BigInt(N);

  const rows: InstallmentScheduleRow[] = [];
  let balance = amountCents;
  let totalInterest = BigInt(0);

  for (let month = 1; month <= N; month++) {
    // Last row absorbs the residue so Σ(capital) === amountCents exactly.
    const isLast = month === N;
    const capitalThis = isLast ? capitalPerPeriod + residueCents : capitalPerPeriod;

    let interestThis: bigint;
    let deferredThis: bigint;
    if (graceMonth && month === 1) {
      // Month 1: interest is computed but deferred to month 2.
      interestThis = BigInt(0);
      deferredThis = BigInt(0);
    } else if (graceMonth && month === 2) {
      // Month 2: own interest + the deferred month-1 interest (based on the
      // original amount, since month 1 paid no capital either — the balance
      // entering month 2 is `amountCents - capital_month_1`).
      const deferredBase = amountCents; // month-1 starts with full amount
      deferredThis = periodInterestCents(deferredBase, rateEmX10k);
      interestThis = periodInterestCents(balance, rateEmX10k);
    } else {
      interestThis = periodInterestCents(balance, rateEmX10k);
      deferredThis = BigInt(0);
    }

    const cuota = capitalThis + interestThis + deferredThis;
    const balanceAfter = balance - capitalThis;

    rows.push({
      month,
      capitalCents: capitalThis,
      interestCents: interestThis,
      deferredInterestCents: deferredThis,
      cuotaCents: cuota,
      balanceAfterCents: balanceAfter,
    });

    totalInterest += interestThis + deferredThis;
    balance = balanceAfter;
  }

  // paid/pending split: count how many period anniversaries have passed since
  // purchaseDate. The 1st cuota is paid when `today >= purchaseDate + 1mo`.
  // We compute this by monthly deltas (calendar months) — not by raw 30-day
  // chunks — so DST-ish edges don't drift.
  const paidCount = Math.max(0, Math.min(N, monthsBetween(purchaseDate, today)));
  const pendingCount = N - paidCount;

  // Sum of cuota_i gives the total-to-pay; average cuota is useful in UI.
  const totalCuotas = rows.reduce((a, r) => a + r.cuotaCents, BigInt(0));
  const monthlyPaymentCents = totalCuotas / BigInt(N);

  const outstandingBalanceCents =
    paidCount >= N ? BigInt(0) : (rows[paidCount - 1]?.balanceAfterCents ?? amountCents);
  const outstandingInterestCents = rows
    .slice(paidCount)
    .reduce((a, r) => a + r.interestCents + r.deferredInterestCents, BigInt(0));

  return {
    rows,
    paidCount,
    pendingCount,
    monthlyPaymentCents,
    totalInterestCents: totalInterest,
    outstandingBalanceCents,
    outstandingInterestCents,
  };
}

// Whole-month count between two dates, rounded down. Used only for paid /
// pending bucketing — precision beyond "has the cuota date passed?" is
// irrelevant here.
export function monthsBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  const years = end.getFullYear() - start.getFullYear();
  const months = end.getMonth() - start.getMonth();
  let delta = years * 12 + months;
  // If the day of `end` is before the day of `start`, the current month
  // hasn't closed yet — subtract one to keep "paid at or after anniversary"
  // semantics.
  if (end.getDate() < start.getDate()) delta -= 1;
  return Math.max(0, delta);
}
