export const FALLBACK_COP_PER_USD = 4000;

export function toCop(
  amountCents: bigint,
  currency: "COP" | "USD",
  copPerUsd: number,
): bigint {
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
