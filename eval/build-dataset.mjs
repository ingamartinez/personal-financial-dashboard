import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);

const raw = JSON.parse(fs.readFileSync(path.join(DIR, "txs.json"), "utf8"));
const rawRule = JSON.parse(fs.readFileSync(path.join(DIR, "txs_rule.json"), "utf8"));
const cats = JSON.parse(fs.readFileSync(path.join(DIR, "categories.json"), "utf8"));

// Exactly what src/lib/classification/pipeline.ts feeds classifyBatchWithAi:
//   description: t.descriptionClean ?? t.merchant ?? t.description
const eff = (t) => t.description_clean ?? t.merchant ?? t.description_raw ?? "";

// ---------------------------------------------------------------------------
// Tier heuristic. HARD = the string does not plainly name a real-world
// merchant: bare account-number templates, bank-internal strings, bare person
// names, bare payment-gateway names, ATM withdrawals. Everything else is EASY.
// A gateway string that still carries the merchant (MERCADO PAGO*MAX,
// DLO*DiDi Food, ARQ purchase: Rappi) is EASY — the merchant is legible.
// ---------------------------------------------------------------------------
const HARD_PATTERNS = [
  /cuenta\s*\*\s*\d+/i, // Transferencia a cuenta *0000000000
  /a\s+llave\s+\d+/i, // Pago QR a llave 0000000000
  /^TRANSFERENCIA CTA SUC VIRTUAL$/i,
  /IMPTO GOBIERNO|4X1000/i, // bank-internal tax
  /MANEJO TARJETA|CUOTA MANEJO|IVA COBRO|COMISION|SOBREGIRO/i,
  /Ajuste de saldo/i,
  /Intereses causados/i,
  /^(RETIRO|CAJERO|ATM)\b/i,
  /PUNTO DE VENTA/i,
];

// Bare payment gateway / opaque acquirer: the gateway name with nothing
// merchant-identifying after it.
const BARE_GATEWAY = [
  /^MERCADO\s*PAGO\s*COLOMBIA$/i,
  /^MERCADOPAGO(\s+COLOMBIA)?$/i,
  /^PAYU/i,
  /^BOLD\s*\*?$/i,
  /^EBANX$/i,
  /^DLO\s*\*?$/i,
  /^DL\s*\*?$/i,
  /^EPAYCO$/i,
  /^PSE$/i,
];

// A bare counterparty name is identified from the ORIGINAL bank string, not
// from casing — "CARULLA FRESH OVIEDO" and "MARIA PAZ TORRES CARRILLO" are
// both all-caps, and only the bank's own wording tells them apart.
// "Transferencia recibida de X" / "Transferencia a X" => X is a person or an
// unnamed counterparty (opaque). "Pago a X" / "Pago PROVEEDOR de X" name a
// real organisation, so those stay EASY.
const BARE_COUNTERPARTY = /Transferencia\s+(recibida\s+)?(de|a)\s+/i;

function tierOf(t) {
  const s = eff(t);
  const rawStr = t.description_raw ?? "";
  if (HARD_PATTERNS.some((r) => r.test(s)) || HARD_PATTERNS.some((r) => r.test(rawStr)))
    return "hard";
  if (BARE_GATEWAY.some((r) => r.test(s.trim()))) return "hard";
  if (BARE_COUNTERPARTY.test(rawStr)) return "hard";
  return "easy";
}

// `adjustments` is owned by reconciliation (#812): buildSystemPrompt filters it
// out of the offered category list and classifyBatchWithAi rejects it again on
// the way back. No model can ever produce it, so scoring it would just add a
// constant miss to every provider. Excluded, reported separately.
const SYSTEM_OWNED = new Set(["adjustments"]);

function toRow(t, source) {
  return {
    id: t.id,
    source,
    tier: tierOf(t),
    description: eff(t),
    descriptionRaw: t.description_raw,
    amountCents: t.amount_cents,
    currency: t.currency,
    truth: t.category_slug,
  };
}

const setA = raw.map((t) => toRow(t, "manual"));
// Set B's rule rows include 43 byte-identical-in-shape "Pago QR a llave NNNN"
// strings that all carry the same label. They add no discriminating signal and
// would just burn tokens, so keep a sample of 8.
let qrSeen = 0;
const setB = rawRule
  .map((t) => toRow(t, "rule"))
  .filter((r) => (/a\s+llave\s+\d+/i.test(r.description) ? ++qrSeen <= 8 : true));

const excluded = setA.filter((r) => SYSTEM_OWNED.has(r.truth));
const scoredA = setA.filter((r) => !SYSTEM_OWNED.has(r.truth));
const scoredB = setB.filter((r) => !SYSTEM_OWNED.has(r.truth));

// Category map + parent lookup for the near-miss metric.
const parentOf = new Map(cats.map((c) => [c.slug, c.parent_slug]));
const root = (slug) => parentOf.get(slug) ?? slug; // top-level slugs map to themselves

fs.writeFileSync(
  path.join(DIR, "dataset.json"),
  JSON.stringify(
    {
      categories: cats.map((c) => ({ slug: c.slug, name: c.name, parentSlug: c.parent_slug })),
      setA: scoredA,
      setB: scoredB,
      excluded,
    },
    null,
    2,
  ),
);

const tally = (rows) => {
  const t = { easy: 0, hard: 0 };
  for (const r of rows) t[r.tier]++;
  return t;
};
console.log("categories:", cats.length, "top-level:", cats.filter((c) => !c.parent_slug).length);
console.log("Set A (manual, scored):", scoredA.length, tally(scoredA));
console.log("Set B (rule, dedup):", scoredB.length, tally(scoredB));
console.log("excluded (system-owned `adjustments`):", excluded.length);
console.log("\n--- Set A hard sample ---");
for (const r of scoredA.filter((x) => x.tier === "hard").slice(0, 8))
  console.log(`  ${r.truth.padEnd(22)} | ${r.description}`);
console.log("--- Set A easy sample ---");
for (const r of scoredA.filter((x) => x.tier === "easy").slice(0, 20))
  console.log(`  ${r.truth.padEnd(22)} | ${r.description}`);
console.log("--- Set B hard sample ---");
for (const r of scoredB.filter((x) => x.tier === "hard").slice(0, 5))
  console.log(`  ${r.truth.padEnd(22)} | ${r.description}`);
console.log("--- Set B easy sample ---");
for (const r of scoredB.filter((x) => x.tier === "easy").slice(0, 10))
  console.log(`  ${r.truth.padEnd(22)} | ${r.description}`);
void root;
