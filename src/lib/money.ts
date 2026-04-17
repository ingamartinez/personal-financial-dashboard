export const FALLBACK_COP_PER_USD = 4000;

const DECIMAL_AMOUNT_RE = /^\d+(?:\.\d{1,2})?$/;

/**
 * Parses a user-entered decimal amount string (e.g. "100.99") into a bigint
 * cents value using integer arithmetic. Avoids float rounding errors — the
 * reason `Math.round(parseFloat(s) * 100)` is unsafe (see `9.995 * 100`).
 *
 * Throws on any input that does not match /^\d+(\.\d{1,2})?$/ — negatives,
 * scientific notation, thousand separators, more than 2 decimals, etc.
 */
export function decimalStringToCents(input: string): bigint {
  const match = DECIMAL_AMOUNT_RE.exec(input);
  if (!match) {
    throw new Error(`Invalid decimal amount: ${JSON.stringify(input)}`);
  }
  const [whole, fraction = ""] = input.split(".");
  const paddedFraction = (fraction + "00").slice(0, 2);
  return BigInt(whole) * BigInt(100) + BigInt(paddedFraction);
}

export function toCop(amountCents: bigint, currency: "COP" | "USD", copPerUsd: number): bigint {
  if (currency === "COP") return amountCents;
  const micros = BigInt(Math.round(copPerUsd * 1_000_000));
  return (amountCents * micros) / BigInt(1_000_000);
}

export function formatCop(amountCents: bigint): string {
  const pesos = Number(amountCents) / 100;
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(pesos);
}

export function formatMoney(amountCents: bigint, currency: "COP" | "USD"): string {
  const value = Number(amountCents) / 100;
  return new Intl.NumberFormat(currency === "USD" ? "en-US" : "es-CO", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "USD" ? 2 : 0,
  }).format(value);
}
