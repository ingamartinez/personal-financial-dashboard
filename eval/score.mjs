import fs from "node:fs";
import path from "node:path";
import { MODELS } from "./models.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ds = JSON.parse(fs.readFileSync(path.join(DIR, "dataset.json"), "utf8"));

const rows = new Map([...ds.setA, ...ds.setB].map((r) => [r.id, r]));
const parentOf = new Map(ds.categories.map((c) => [c.slug, c.parentSlug]));
const validSlugs = new Set(ds.categories.map((c) => c.slug));
const SYSTEM_OWNED = new Set(["adjustments"]);
const root = (s) => (s == null ? null : (parentOf.get(s) ?? s));

// "Convention-bound" rows: a bare transfer / bare counterparty string whose
// ground-truth label sits in the transferencias|ingresos cluster. These strings
// carry no signal that separates `transferencias` from its child
// `transferencia-persona`, or `ingresos` from its children — and the system
// prompt explicitly instructs "prefer subcategories", which contradicts how the
// user actually labelled them. No model can win these; they measure a taxonomy
// convention, not classification skill. Scored separately.
const CLUSTER = new Set([
  "transferencias",
  "transferencia-persona",
  "ingresos",
  "regalo-recibido",
  "otros-ingresos",
  "salario",
  "freelance",
  "reembolso",
]);
const isConventionBound = (r) =>
  r.tier === "hard" &&
  CLUSTER.has(r.truth) &&
  /cuenta\s*\*|a\s+llave\s+\d|Transferencia\s+(recibida\s+)?(de|a)\s|CTA SUC VIRTUAL/i.test(
    `${r.description} ${r.descriptionRaw ?? ""}`,
  );

const pct = (n, d) => (d ? (100 * n) / d : 0);
const q = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const results = [];
for (const spec of MODELS) {
  const f = path.join(DIR, "results", `${spec.key.replace(/\//g, "__")}.json`);
  if (!fs.existsSync(f)) continue;
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));

  const stat = {
    key: spec.key,
    label: spec.label,
    price: spec.price,
    ceiling: !!spec.ceiling,
    batchesTotal: rec.batches.length,
    batchesFailed: 0,
    batchesStrictOk: 0,
    batchesShimOk: 0,
    shimNeeded: 0,
    exceedsProdMaxTokens: 0,
    tokensIn: 0,
    tokensCachedIn: 0,
    tokensOut: 0,
    latencies: [],
    providerCostUsd: 0,
    idsMissing: 0,
    idsDuplicated: 0,
    idsUnknown: 0,
    hallucinatedSlugs: 0,
    tiers: {},
    confBuckets: {},
    hardConfidentWrong: 0,
    hardConfidentTotal: 0,
  };
  for (const t of ["easy", "hard", "hardDecidable", "convention"])
    stat.tiers[t] = { n: 0, exact: 0, family: 0, null: 0, wrong: 0, proposals: 0 };
  stat.confusion = {};
  for (const b of ["0-49", "50-69", "70-89", "90-100"])
    stat.confBuckets[b] = { n: 0, correct: 0, confSum: 0 };

  const seen = new Set();

  for (const batch of rec.batches) {
    if (batch.failed) {
      stat.batchesFailed++;
      continue;
    }
    stat.tokensIn += batch.usage.in;
    stat.tokensCachedIn += batch.usage.cachedIn ?? 0;
    stat.tokensOut += batch.usage.out;
    stat.latencies.push(batch.latencyMs);
    if (batch.usage.providerCostUsd) stat.providerCostUsd += batch.usage.providerCostUsd;
    if (batch.exceedsProdMaxTokens) stat.exceedsProdMaxTokens++;
    if (!batch.schemaErrors.length) stat.batchesStrictOk++;
    if (!batch.schemaErrorsShimmed.length) stat.batchesShimOk++;
    if (batch.shimApplied) stat.shimNeeded++;

    const cls = batch.classifications ?? [];
    const byId = new Map();
    for (const c of cls) {
      if (byId.has(c.id)) stat.idsDuplicated++;
      else byId.set(c.id, c);
    }
    for (const id of batch.ids) if (!byId.has(id)) stat.idsMissing++;
    for (const id of byId.keys()) if (!batch.ids.includes(id)) stat.idsUnknown++;

    for (const id of batch.ids) {
      const truth = rows.get(id);
      if (!truth || seen.has(id)) continue;
      seen.add(id);
      const c = byId.get(id);
      const conv = isConventionBound(truth);
      const buckets = [stat.tiers[truth.tier]];
      if (conv) buckets.push(stat.tiers.convention);
      else if (truth.tier === "hard") buckets.push(stat.tiers.hardDecidable);
      for (const T of buckets) T.n++;

      const rawSlug = c?.categorySlug ?? null;
      if (rawSlug && !validSlugs.has(rawSlug)) stat.hallucinatedSlugs++;
      // Production sanitization (classifyBatchWithAi): a slug outside the
      // user's live category set, or a system-owned slug, becomes null.
      const pred =
        rawSlug && validSlugs.has(rawSlug) && !SYSTEM_OWNED.has(rawSlug) ? rawSlug : null;
      if (c?.proposedCategory) for (const T of buckets) T.proposals++;

      const exact = pred === truth.truth;
      const family = pred != null && root(pred) === root(truth.truth);
      for (const T of buckets) {
        if (pred == null) T.null++;
        else if (exact) T.exact++;
        else T.wrong++;
        if (family && !exact) T.family++;
      }
      if (!exact) {
        const k = `${truth.truth} -> ${pred}`;
        stat.confusion[k] = (stat.confusion[k] ?? 0) + 1;
      }

      const conf = Number.isInteger(c?.confidence) ? c.confidence : null;
      if (conf != null && pred != null) {
        const b = conf >= 90 ? "90-100" : conf >= 70 ? "70-89" : conf >= 50 ? "50-69" : "0-49";
        stat.confBuckets[b].n++;
        stat.confBuckets[b].confSum += conf;
        if (exact) stat.confBuckets[b].correct++;
        if (truth.tier === "hard") {
          if (conf >= 90) {
            stat.hardConfidentTotal++;
            if (!exact) stat.hardConfidentWrong++;
          }
        }
      }
    }
  }

  const scored = stat.tiers.easy.n + stat.tiers.hard.n;
  const totalExact = stat.tiers.easy.exact + stat.tiers.hard.exact;
  const totalFamily = totalExact + stat.tiers.easy.family + stat.tiers.hard.family;
  const costUsd =
    (stat.tokensIn * spec.price.in +
      stat.tokensCachedIn * spec.price.cachedIn +
      stat.tokensOut * spec.price.out) /
    1e6;

  // Expected Calibration Error over the four confidence buckets.
  let ece = 0;
  let ceN = 0;
  for (const b of Object.values(stat.confBuckets)) {
    if (!b.n) continue;
    ceN += b.n;
    ece += b.n * Math.abs(b.confSum / b.n / 100 - b.correct / b.n);
  }
  ece = ceN ? ece / ceN : 0;

  results.push({
    ...stat,
    scored,
    exactPct: pct(totalExact, scored),
    familyPct: pct(totalFamily, scored),
    easyExactPct: pct(stat.tiers.easy.exact, stat.tiers.easy.n),
    hardExactPct: pct(stat.tiers.hard.exact, stat.tiers.hard.n),
    easyFamilyPct: pct(stat.tiers.easy.exact + stat.tiers.easy.family, stat.tiers.easy.n),
    hardFamilyPct: pct(stat.tiers.hard.exact + stat.tiers.hard.family, stat.tiers.hard.n),
    hardDecidableExactPct: pct(stat.tiers.hardDecidable.exact, stat.tiers.hardDecidable.n),
    hardDecidableFamilyPct: pct(
      stat.tiers.hardDecidable.exact + stat.tiers.hardDecidable.family,
      stat.tiers.hardDecidable.n,
    ),
    conventionExactPct: pct(stat.tiers.convention.exact, stat.tiers.convention.n),
    conventionFamilyPct: pct(
      stat.tiers.convention.exact + stat.tiers.convention.family,
      stat.tiers.convention.n,
    ),
    topConfusion: Object.entries(stat.confusion)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3),
    nullPct: pct(stat.tiers.easy.null + stat.tiers.hard.null, scored),
    hardNullPct: pct(stat.tiers.hard.null, stat.tiers.hard.n),
    schemaStrictPct: pct(stat.batchesStrictOk, stat.batchesTotal),
    schemaShimPct: pct(stat.batchesShimOk, stat.batchesTotal),
    costUsd,
    costPer1k: scored ? (costUsd / scored) * 1000 : 0,
    p50: q(stat.latencies, 0.5),
    p95: q(stat.latencies, 0.95),
    ece,
    hardConfWrongPct: pct(stat.hardConfidentWrong, stat.hardConfidentTotal),
  });
}

results.sort((a, b) => b.exactPct - a.exactPct);
fs.writeFileSync(path.join(DIR, "scores.json"), JSON.stringify(results, null, 2));

const f1 = (x) => x.toFixed(1);
const H = [
  ["model", 34],
  ["easy", 5],
  ["hardDec", 7],
  ["conv", 5],
  ["exact", 5],
  ["family", 6],
  ["null%", 5],
  ["schema", 6],
  ["$/1k", 7],
  ["p50s", 5],
  ["p95s", 5],
  ["ECE", 4],
];
console.log("\n" + H.map(([h, w]) => h.padEnd(w)).join(" | "));
console.log("-".repeat(H.reduce((a, [, w]) => a + w + 3, 0)));
for (const r of results) {
  console.log(
    [
      r.key.padEnd(34),
      f1(r.easyExactPct).padStart(5),
      f1(r.hardDecidableExactPct).padStart(7),
      f1(r.conventionExactPct).padStart(5),
      f1(r.exactPct).padStart(5),
      f1(r.familyPct).padStart(6),
      f1(r.nullPct).padStart(5),
      (f1(r.schemaStrictPct) + "%").padStart(6),
      ("$" + r.costPer1k.toFixed(3)).padStart(7),
      (r.p50 / 1000).toFixed(1).padStart(5),
      (r.p95 / 1000).toFixed(1).padStart(5),
      r.ece.toFixed(2).padStart(4),
    ].join(" | "),
  );
}
console.log(
  "\ntier sizes: easy=" +
    results[0].tiers.easy.n +
    " hardDecidable=" +
    results[0].tiers.hardDecidable.n +
    " convention=" +
    results[0].tiers.convention.n,
);
console.log("\ntop confusions:");
for (const r of results)
  console.log("  " + r.key.padEnd(32) + r.topConfusion.map(([k, v]) => `${k} x${v}`).join(" | "));
console.log("\ncalibration (hard tier, confidence>=90 but wrong):");
for (const r of results)
  console.log(
    `  ${r.key.padEnd(32)} ${r.hardConfidentWrong}/${r.hardConfidentTotal} (${f1(r.hardConfWrongPct)}%)`,
  );
console.log("\nspend actually incurred by this eval:");
let total = 0;
for (const r of results) {
  total += r.costUsd;
  console.log(
    `  ${r.key.padEnd(32)} $${r.costUsd.toFixed(4)}  (in ${r.tokensIn} cached ${r.tokensCachedIn} out ${r.tokensOut})` +
      (r.providerCostUsd ? `  [provider-reported $${r.providerCostUsd.toFixed(4)}]` : ""),
  );
}
console.log(`  TOTAL $${total.toFixed(4)}`);
console.log("\nintegrity:");
for (const r of results)
  console.log(
    `  ${r.key.padEnd(32)} failedBatches=${r.batchesFailed} shimNeeded=${r.shimNeeded}/${r.batchesTotal} missingIds=${r.idsMissing} dupIds=${r.idsDuplicated} unknownIds=${r.idsUnknown} halluc=${r.hallucinatedSlugs} over2048=${r.exceedsProdMaxTokens}`,
  );
