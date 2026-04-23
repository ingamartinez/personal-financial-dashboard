// #433 — flexible amount parser for the "saldo real" input. Handles both COP
// ("1.500.000,50") and US ("1,500,000.50") formats, plus plain decimals
// ("-1500000.5") and bare integers ("-1500000"). Returns `null` for invalid
// input; `undefined` when the field is empty (user opted out).
//
// Heuristic: if the last separator is followed by MORE THAN 2 digits, treat
// it as a thousand-separator (not a decimal) — 3+ digits after the decimal
// is vanishingly rare in money.
//
// Lives in a separate module (not the "use client" form) so tests can import
// it directly without pulling the whole next-auth / next/navigation tree.
export function parseSignedAmountToCents(raw: string): bigint | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let s = trimmed;
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);
  s = s.replace(/[\s$]/g, "");
  if (!/^[0-9.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let integerPart: string;
  let fractionalPart: string;
  if (lastDot === -1 && lastComma === -1) {
    integerPart = s;
    fractionalPart = "0";
  } else {
    const idx = lastDot > lastComma ? lastDot : lastComma;
    const tail = s.slice(idx + 1);
    if (tail.length === 0 || tail.length > 2) {
      integerPart = s.replace(/[.,]/g, "");
      fractionalPart = "0";
    } else {
      integerPart = s.slice(0, idx).replace(/[.,]/g, "");
      fractionalPart = tail;
    }
  }

  if (integerPart === "" || !/^\d+$/.test(integerPart)) return null;
  if (!/^\d+$/.test(fractionalPart)) return null;

  const centsFrac = fractionalPart.padEnd(2, "0").slice(0, 2);
  const cents = BigInt(integerPart) * BigInt(100) + BigInt(centsFrac);
  return negative ? -cents : cents;
}
