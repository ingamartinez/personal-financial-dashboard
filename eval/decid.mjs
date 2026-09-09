import fs from "node:fs";
import { MODELS } from "./models.mjs";
const ds = JSON.parse(fs.readFileSync("dataset.json"));
const rows = new Map([...ds.setA, ...ds.setB].map((r) => [r.id, r]));
const parentOf = new Map(ds.categories.map((c) => [c.slug, c.parentSlug]));
const valid = new Set(ds.categories.map((c) => c.slug));
const root = (s) => (s == null ? null : (parentOf.get(s) ?? s));
const CL = new Set([
  "transferencias",
  "transferencia-persona",
  "ingresos",
  "regalo-recibido",
  "otros-ingresos",
  "salario",
  "freelance",
  "reembolso",
]);
const isConv = (r) =>
  r.tier === "hard" &&
  CL.has(r.truth) &&
  /cuenta\s*\*|a\s+llave\s+\d|Transferencia\s+(recibida\s+)?(de|a)\s|CTA SUC VIRTUAL/i.test(
    r.description + " " + (r.descriptionRaw ?? ""),
  );
console.log("model".padEnd(30), "decidN", "decidExact", "afterTaxonomyFix(217)");
for (const spec of MODELS) {
  const f = "results/" + spec.key.replace(/\//g, "__") + ".json";
  if (!fs.existsSync(f)) continue;
  const rec = JSON.parse(fs.readFileSync(f));
  const M = new Map();
  for (const b of rec.batches) {
    if (b.failed) continue;
    for (const c of b.classifications || []) if (!M.has(c.id)) M.set(c.id, c);
  }
  let dn = 0,
    de = 0,
    fx = 0,
    tot = 0;
  for (const [id, r] of rows) {
    const c = M.get(id);
    const raw = c?.categorySlug ?? null;
    const p = raw && valid.has(raw) && raw !== "adjustments" ? raw : null;
    tot++;
    const exact = p === r.truth;
    const fam = p != null && root(p) === root(r.truth);
    if (!isConv(r)) {
      dn++;
      if (exact) de++;
    }
    if (isConv(r) ? fam : exact) fx++;
  }
  console.log(
    spec.key.padEnd(30),
    String(dn).padStart(6),
    ((100 * de) / dn).toFixed(1).padStart(10),
    ((100 * fx) / tot).toFixed(1).padStart(21),
  );
}
