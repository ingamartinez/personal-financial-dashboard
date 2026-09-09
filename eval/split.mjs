// Quantifies a split strategy: cheap model on the easy tier, strong model on
// the hard tier, versus every single-model option. Uses per-row correctness
// already measured, and per-row cost apportioned from each model's measured
// tokens (batch tokens / rows in that batch).
import fs from "node:fs";
import path from "node:path";
import { MODELS } from "./models.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ds = JSON.parse(fs.readFileSync(path.join(DIR, "dataset.json"), "utf8"));
const rows = new Map([...ds.setA, ...ds.setB].map((r) => [r.id, r]));
const parentOf = new Map(ds.categories.map((c) => [c.slug, c.parentSlug]));
const validSlugs = new Set(ds.categories.map((c) => c.slug));
const root = (s) => (s == null ? null : (parentOf.get(s) ?? s));

// Per model: id -> { exact, family, costUsd }
const per = new Map();
for (const spec of MODELS) {
  const f = path.join(DIR, "results", `${spec.key.replace(/\//g, "__")}.json`);
  if (!fs.existsSync(f)) continue;
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  const m = new Map();
  for (const b of rec.batches) {
    if (b.failed) continue;
    const n = b.ids.length;
    const batchCost =
      (b.usage.in * spec.price.in +
        (b.usage.cachedIn ?? 0) * spec.price.cachedIn +
        b.usage.out * spec.price.out) /
      1e6;
    const byId = new Map((b.classifications ?? []).map((c) => [c.id, c]));
    for (const id of b.ids) {
      const truth = rows.get(id);
      if (!truth || m.has(id)) continue;
      const raw = byId.get(id)?.categorySlug ?? null;
      const pred = raw && validSlugs.has(raw) && raw !== "adjustments" ? raw : null;
      m.set(id, {
        exact: pred === truth.truth,
        family: pred != null && root(pred) === root(truth.truth),
        cost: batchCost / n,
        tier: truth.tier,
      });
    }
  }
  per.set(spec.key, m);
}

const ids = [...rows.keys()].filter((id) => [...per.values()].every((m) => m.has(id)));
const easyIds = ids.filter((id) => rows.get(id).tier === "easy");
const hardIds = ids.filter((id) => rows.get(id).tier === "hard");

function evaluate(easyModel, hardModel) {
  let exact = 0;
  let family = 0;
  let cost = 0;
  for (const id of easyIds) {
    const r = per.get(easyModel).get(id);
    if (r.exact) exact++;
    if (r.family) family++;
    cost += r.cost;
  }
  for (const id of hardIds) {
    const r = per.get(hardModel).get(id);
    if (r.exact) exact++;
    if (r.family) family++;
    cost += r.cost;
  }
  const n = ids.length;
  return {
    exactPct: (100 * exact) / n,
    familyPct: (100 * family) / n,
    costPer1k: (cost / n) * 1000,
  };
}

const keys = [...per.keys()];
const out = [];
for (const k of keys) out.push({ name: `single: ${k}`, ...evaluate(k, k) });
for (const e of keys)
  for (const h of keys) {
    if (e === h) continue;
    out.push({ name: `split: easy=${e} / hard=${h}`, ...evaluate(e, h) });
  }

// Pareto frontier on (cost, family accuracy).
out.sort((a, b) => a.costPer1k - b.costPer1k);
const frontier = [];
let best = -1;
for (const o of out) {
  if (o.familyPct > best) {
    frontier.push(o);
    best = o.familyPct;
  }
}

console.log(
  `rows compared across all ${keys.length} models: ${ids.length} (easy ${easyIds.length}, hard ${hardIds.length})\n`,
);
console.log("=== PARETO FRONTIER (cost vs family accuracy) ===");
console.log("cost/1k".padStart(9), "family".padStart(7), "exact".padStart(6), " strategy");
for (const o of frontier)
  console.log(
    ("$" + o.costPer1k.toFixed(3)).padStart(9),
    o.familyPct.toFixed(1).padStart(7),
    o.exactPct.toFixed(1).padStart(6),
    "",
    o.name,
  );

console.log("\n=== all single-model options, by family accuracy ===");
for (const o of out
  .filter((x) => x.name.startsWith("single"))
  .sort((a, b) => b.familyPct - a.familyPct))
  console.log(
    ("$" + o.costPer1k.toFixed(3)).padStart(9),
    o.familyPct.toFixed(1).padStart(7),
    o.exactPct.toFixed(1).padStart(6),
    "",
    o.name,
  );

console.log("\n=== best splits by family accuracy (top 10) ===");
for (const o of out
  .filter((x) => x.name.startsWith("split"))
  .sort((a, b) => b.familyPct - a.familyPct)
  .slice(0, 10))
  console.log(
    ("$" + o.costPer1k.toFixed(3)).padStart(9),
    o.familyPct.toFixed(1).padStart(7),
    o.exactPct.toFixed(1).padStart(6),
    "",
    o.name,
  );

fs.writeFileSync(path.join(DIR, "split.json"), JSON.stringify({ all: out, frontier }, null, 2));
