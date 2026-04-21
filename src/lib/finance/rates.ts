// #406: interest-rate conversion + validation helpers for credit-card
// financials. Every `*_bps` value the app ingests, stores, or renders is
// Efectiva Mensual Vencida (EM / MV). Display as EA is computed on read only.
//
// Rationale for the hard convention: during #345 scoping we caught a bank
// agent verbally conflating EM and EA; the two differ by ~12× in cuota
// terms. Storing EA by accident would produce silent data corruption (wrong
// cuota ≈ 1/12 of the real one) with no runtime error. See finding F3 of
// #345 and memory `findash/convention/interest-rate-unit`.
//
// Basis points (bps): 10000 bps = 100%. So 1.9110% EM = 191 bps. We pick bps
// over floats because the storage column is smallint — exact, small, and
// free of rounding.

// Minimum non-zero EM we accept. 50 bps = 0.5% EM = ~6.17% EA. TC rates in
// Colombia sit around 1.9% EM (~25% EA) — anything under 0.5% EM is almost
// certainly an EA value mislabeled as EM. 0 stays valid (diferido sin
// intereses — Bancolombia's 1-cuota bucket).
export const MIN_NON_ZERO_EM_BPS = 50;

// Upper sanity bound. 10000 bps = 100% EM (which as EA is absurd). If someone
// types a rate ≥ this, it's almost certainly a typo. Validator catches it so
// the schedule helper in #407 never sees garbage.
export const MAX_EM_BPS = 10000;

export type RateValidationResult =
  | { ok: true }
  | { ok: false; reason: "negative" | "too-low" | "too-high" | "not-integer" };

// Pure validation. Returns a specific reason so callers (server action,
// form) can surface a useful message — not just "invalid".
export function validateInstallmentRateBps(bps: number): RateValidationResult {
  if (!Number.isInteger(bps)) return { ok: false, reason: "not-integer" };
  if (bps < 0) return { ok: false, reason: "negative" };
  if (bps > 0 && bps < MIN_NON_ZERO_EM_BPS) return { ok: false, reason: "too-low" };
  if (bps >= MAX_EM_BPS) return { ok: false, reason: "too-high" };
  return { ok: true };
}

// Human-readable explanation of why a rate was rejected. Used in API / form
// errors — leads with the likely user mistake (EM vs EA confusion).
export function rateValidationMessage(
  reason: Exclude<RateValidationResult, { ok: true }>["reason"],
): string {
  switch (reason) {
    case "negative":
      return "La tasa no puede ser negativa.";
    case "too-low":
      return "Tasa sospechosamente baja. ¿Seguro que es EM (mensual) y no EA (anual)? 1% EM ≈ 12.68% EA. Para guardar una tasa EA, convertila primero.";
    case "too-high":
      return "Tasa fuera de rango razonable (≥ 100% EM).";
    case "not-integer":
      return "La tasa debe estar expresada en basis points (número entero).";
  }
}

// Convert EM (as a decimal fraction — 0.0191 = 1.91% monthly) to EA. Formula:
// EA = (1 + EM)^12 - 1. Uses JS Math so result is a plain number — fine for
// DISPLAY (we never persist EA).
export function emToEa(em: number): number {
  return Math.pow(1 + em, 12) - 1;
}

// Inverse of `emToEa`. EA as decimal → EM as decimal.
// EM = (1 + EA)^(1/12) - 1.
export function eaToEm(ea: number): number {
  return Math.pow(1 + ea, 1 / 12) - 1;
}

// Convenience: bps EM → decimal EA. Example: 1910 bps EM → 0.2550 EA.
export function bpsEmToEa(bps: number): number {
  return emToEa(bps / 10000);
}

// Convenience: bps EM → formatted "X.XXXX%" (mirrors how Bancolombia prints
// these on statements). 4 decimals keeps historical rates like 1.8311%
// lossless; the input box should use the same precision.
export function formatBpsEmAsPercent(bps: number, decimals = 4): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}

// Convenience: bps EM → formatted "X.XX%" EA for read-only display next to
// the EM input (the "1.91% EM · 25.50% EA" pattern the UI uses).
export function formatBpsEmAsEaPercent(bps: number, decimals = 2): string {
  const ea = bpsEmToEa(bps);
  return `${(ea * 100).toFixed(decimals)}%`;
}

// Parses the user's typed percent ("1.9110", "1,9110", "1.9110%") into
// bps as an integer. Returns null when the input is invalid. Used by the
// account + tx edit forms.
export function parsePercentToBps(input: string): number | null {
  const trimmed = input.trim().replace(/%\s*$/, "");
  if (!trimmed) return null;
  const normalized = trimmed.replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// Bucket resolver for the #407 schedule helper. Returns the EM bps that a
// purchase of `installmentsTotal` cuotas should use when the transaction
// row has no explicit `installment_rate_bps`. Null when the bucket isn't
// populated — the caller decides between 0 (best-effort) and an error.
export function resolveBucketRateBps(
  buckets: { oneMonth?: number; months2to36?: number; advances?: number } | undefined,
  installmentsTotal: number,
  isAdvance = false,
): number | null {
  if (!buckets) return null;
  if (isAdvance) return buckets.advances ?? null;
  if (installmentsTotal <= 1) return buckets.oneMonth ?? null;
  if (installmentsTotal <= 36) return buckets.months2to36 ?? null;
  // Beyond 36 cuotas the extract doesn't show a distinct bucket — use the
  // same rate as 2-36. Real-world exceptions (e.g. compra de cartera at a
  // preferential rate) go on the per-tx `installment_rate_bps` override.
  return buckets.months2to36 ?? null;
}
