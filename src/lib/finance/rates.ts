// #406/#411: interest-rate conversion + validation helpers for credit-card
// financials. Every rate value the app ingests, stores, or renders is
// Efectiva Mensual Vencida (EM / MV), stored as PERCENT × 10000 so the app
// preserves the 4 decimals Bancolombia prints on real extracts (e.g.
// "1.9110%" → 19110). Display as EA is computed on read only.
//
// Rationale for the hard convention: during #345 scoping we caught a bank
// agent verbally conflating EM and EA; the two differ by ~12× in cuota
// terms. Storing EA by accident would produce silent data corruption (wrong
// cuota ≈ 1/12 of the real one) with no runtime error. See finding F3 of
// #345 and memory `findash/convention/interest-rate-unit`.
//
// Scale: stored = percent × 10000. Equivalent terms: "basis points × 100",
// "hundredths of a basis point", "permyriad × 100". We picked x10000
// because it maps 1-to-1 with Bancolombia's 4-decimal extract display:
// `1.9110%` → 19110 with no rounding.

// Conversion constants. Stored integer ÷ EM_PER_FRACTIONAL = fractional rate.
export const EM_X10K_SCALE = 10000; // multiplier from percent to stored units
export const EM_X10K_PER_FRACTIONAL = 1_000_000; // stored ÷ this = fractional (e.g. 0.019110)

// Minimum non-zero EM we accept. 5000 (x10k) = 0.5% EM ≈ 6.17% EA. TC rates
// in Colombia sit around 1.9% EM (~25% EA) — anything under 0.5% EM is
// almost certainly an EA value mislabeled as EM. 0 stays valid (diferido
// sin intereses — Bancolombia's 1-cuota bucket).
export const MIN_NON_ZERO_EM_X10K = 5000;

// Upper sanity bound. 1_000_000 (x10k) = 100% EM (which as EA is absurd).
// If someone types a rate ≥ this, it's almost certainly a typo. Validator
// catches it so the schedule helper in #407 never sees garbage.
export const MAX_EM_X10K = 1_000_000;

export type RateValidationResult =
  | { ok: true }
  | { ok: false; reason: "negative" | "too-low" | "too-high" | "not-integer" };

// Pure validation. Returns a specific reason so callers (server action,
// form) can surface a useful message — not just "invalid".
export function validateInstallmentRate(storedX10k: number): RateValidationResult {
  if (!Number.isInteger(storedX10k)) return { ok: false, reason: "not-integer" };
  if (storedX10k < 0) return { ok: false, reason: "negative" };
  if (storedX10k > 0 && storedX10k < MIN_NON_ZERO_EM_X10K) {
    return { ok: false, reason: "too-low" };
  }
  if (storedX10k >= MAX_EM_X10K) return { ok: false, reason: "too-high" };
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
      return "La tasa debe estar expresada como entero (percent × 10000).";
  }
}

// Convert EM (fractional — 0.0191 = 1.91% monthly) to EA. Formula:
// EA = (1 + EM)^12 - 1. Uses JS Math so result is a plain number — fine for
// DISPLAY (we never persist EA).
export function emToEa(em: number): number {
  return Math.pow(1 + em, 12) - 1;
}

// Inverse of `emToEa`. EA fractional → EM fractional.
// EM = (1 + EA)^(1/12) - 1.
export function eaToEm(ea: number): number {
  return Math.pow(1 + ea, 1 / 12) - 1;
}

// Convenience: stored EM (x10k) → fractional EA. Example: 19110 → 0.25503
// (= 25.5026% rounded).
export function emX10kToEa(storedX10k: number): number {
  return emToEa(storedX10k / EM_X10K_PER_FRACTIONAL);
}

// Convenience: stored EM (x10k) → formatted "X.XXXX%" (mirrors how
// Bancolombia prints these on statements). 4 decimals keeps historical
// rates like 1.8311% lossless; the input box should use the same precision.
export function formatEmX10kAsPercent(storedX10k: number, decimals = 4): string {
  return `${(storedX10k / EM_X10K_SCALE).toFixed(decimals)}%`;
}

// Convenience: stored EM (x10k) → formatted "X.XX%" EA for read-only display
// next to the EM input (the "1.9110% EM · 25.50% EA" pattern the UI uses).
export function formatEmX10kAsEaPercent(storedX10k: number, decimals = 2): string {
  const ea = emX10kToEa(storedX10k);
  return `${(ea * 100).toFixed(decimals)}%`;
}

// Parses the user's typed percent ("1.9110", "1,9110", "1.9110%") into the
// stored integer. Returns null when the input is invalid. Rounds half-up to
// the 4th decimal — anything finer is noise the schema can't represent.
export function parsePercentToEmX10k(input: string): number | null {
  const trimmed = input.trim().replace(/%\s*$/, "");
  if (!trimmed) return null;
  const normalized = trimmed.replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * EM_X10K_SCALE);
}

// Bucket resolver for the #407 schedule helper. Returns the stored EM x10k
// that a purchase of `installmentsTotal` cuotas should use when the
// transaction row has no explicit `installment_rate_em_x10k`. Null when
// the bucket isn't populated — the caller decides between 0 (best-effort)
// and an error.
export function resolveBucketRateX10k(
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
  // preferential rate) go on the per-tx `installment_rate_em_x10k`.
  return buckets.months2to36 ?? null;
}
