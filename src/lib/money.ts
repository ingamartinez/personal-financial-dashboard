import type { Currency } from "@/lib/types";

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

export function toCop(amountCents: bigint, currency: Currency, copPerUsd: number): bigint {
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

export function formatMoney(amountCents: bigint, currency: Currency): string {
  const value = Number(amountCents) / 100;
  return new Intl.NumberFormat(currency === "USD" ? "en-US" : "es-CO", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "USD" ? 2 : 0,
  }).format(value);
}

/**
 * Tolerant parser for user-entered money. Accepts negatives and both
 * es-CO ("1.234.567,89") and en-US ("1,234,567.89") grouping styles, plus
 * plain forms ("1234567", "1234.56"). Returns signed bigint cents.
 *
 * Heuristic for decimal separator: the LAST `.` or `,` followed by 1-2
 * digits is treated as the decimal; anything else is a thousand separator
 * and stripped. Matches how humans write money across locales without
 * making the caller pass a locale.
 */
export function parseTolerantMoney(input: string): bigint {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("Empty money input");
  const negative = trimmed.startsWith("-");
  const body = (negative ? trimmed.slice(1) : trimmed).replace(/[\s$]/g, "");
  if (!/^[\d.,]+$/.test(body)) {
    throw new Error(`Invalid money input: ${JSON.stringify(input)}`);
  }
  const decimalMatch = body.match(/[.,](\d{1,2})$/);
  let normalized: string;
  if (decimalMatch) {
    const whole = body.slice(0, -decimalMatch[0].length).replace(/[.,]/g, "");
    normalized = `${whole || "0"}.${decimalMatch[1]}`;
  } else {
    normalized = body.replace(/[.,]/g, "");
  }
  const cents = decimalStringToCents(normalized);
  return negative ? -cents : cents;
}
