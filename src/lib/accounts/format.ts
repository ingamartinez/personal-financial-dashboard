// Institution slug → human-readable label. Keep in sync with the
// `institution_slug` pgEnum in schema.ts.
export const INSTITUTION_LABELS: Record<string, string> = {
  bancolombia: "Bancolombia",
  davivienda: "Davivienda",
  nequi: "Nequi",
  bbva: "BBVA",
  scotiabank: "Scotiabank",
  bancogalicia: "Banco Galicia",
  rappipay: "RappiPay",
  amex: "Amex",
  cash: "Efectivo",
  other: "Otra",
};

// Single source of truth for rendering an account as a user-visible label.
// The DB keeps `name`, `currency`, `institution`, and `metadata.last4s` as
// separate fields — never stuff disambiguating bits back into `name`.
//
// Default output: `${name} (${currency})`. Opts add `institution` prefix or a
// `*last4` segment between name and currency.

type AccountLike = {
  name: string;
  currency: string;
  institution?: string | null;
  // DB rows expose last4s under metadata; NluAccountOption flattens it. Accept
  // either shape so callers don't have to massage the row first.
  last4s?: string[] | null;
  metadata?: { last4s?: string[] | null } | null;
};

type FormatOptions = {
  withInstitution?: boolean;
  withLast4?: boolean;
};

export function formatAccountLabel(a: AccountLike, opts: FormatOptions = {}): string {
  const last4 = opts.withLast4 ? (a.last4s?.[0] ?? a.metadata?.last4s?.[0]) : undefined;
  // Most accounts already embed "*1234" in the name; skip the suffix to avoid
  // rendering "Visa *1234 *1234".
  const last4Part = last4 && !a.name.includes(`*${last4}`) ? ` *${last4}` : "";
  const base = `${a.name}${last4Part} (${a.currency})`;
  if (opts.withInstitution && a.institution) {
    return `${a.institution} · ${base}`;
  }
  return base;
}
