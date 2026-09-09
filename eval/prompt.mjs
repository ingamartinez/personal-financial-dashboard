// Loads buildSystemPrompt / buildUserPrompt VERBATIM out of the repo source.
// Nothing is retyped here — the function bodies are sliced straight out of
// src/lib/classification/ai.ts and evaluated, so the prompts every provider
// sees are byte-identical to production's.
import fs from "node:fs";

const AI_TS = new URL("../src/lib/classification/ai.ts", import.meta.url).pathname;

const src = fs.readFileSync(AI_TS, "utf8");

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error(`marker not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(a, b);
}

// LEARN_HINTS_IN_PROMPT + formatUserHints + buildSystemPrompt + buildUserPrompt
const block = slice("const LEARN_HINTS_IN_PROMPT", "export type AiSingleClassifyResult");

// Strip TypeScript annotations that plain JS can't parse. These are the only
// type constructs inside the sliced block.
const js = block
  .replace(
    /function formatUserHints\(hints: AiUserHint\[\]\): string/,
    "function formatUserHints(hints)",
  )
  .replace(
    /function buildSystemPrompt\(cats: AiCategoryOption\[\]\): string/,
    "function buildSystemPrompt(cats)",
  )
  .replace(
    /function buildUserPrompt\(txs: AiClassifiable\[\], userHints: AiUserHint\[\]\): string/,
    "function buildUserPrompt(txs, userHints)",
  )
  .replace(/const lines: string\[\] = \[\];/, "const lines = [];")
  .replace(
    /const byMerchant = new Map<string, AiUserHint\[\]>\(\);/,
    "const byMerchant = new Map();",
  );

if (/:\s*(string|number|AiUserHint|AiCategoryOption|AiClassifiable)/.test(js)) {
  throw new Error("unstripped TypeScript annotation remains — refusing to run");
}

const factory = new Function(
  `${js}\nreturn { buildSystemPrompt, buildUserPrompt, formatUserHints };`,
);
export const { buildSystemPrompt, buildUserPrompt } = factory();

// The production Zod schema, mirrored as a plain validator + as JSON Schema.
// Shape is taken from `responseSchema` in the same file; assert it hasn't drifted.
const SCHEMA_SRC = slice("const responseSchema = z.object({", "// User hints are the soft-signal");
for (const needle of [
  "id: z.number().int()",
  "categorySlug: z.string().min(1).max(60).nullable()",
  "confidence: z.number().int().min(0).max(100)",
  "reason: z.string().max(200).optional()",
  "name: z.string().min(1).max(80)",
  "parentSlug: z.string().min(1).max(60).nullable()",
]) {
  if (!SCHEMA_SRC.includes(needle)) {
    throw new Error(`responseSchema drifted, missing: ${needle}`);
  }
}

/** Mirrors `responseSchema` in src/lib/classification/ai.ts. */
export function validateResponse(obj) {
  const errs = [];
  if (obj === null || typeof obj !== "object") return ["not an object"];
  if (!Array.isArray(obj.classifications)) return ["classifications is not an array"];
  obj.classifications.forEach((c, i) => {
    const p = `classifications[${i}]`;
    if (!Number.isInteger(c?.id)) errs.push(`${p}.id not an int`);
    const cs = c?.categorySlug;
    if (!(cs === null || (typeof cs === "string" && cs.length >= 1 && cs.length <= 60)))
      errs.push(`${p}.categorySlug invalid`);
    const cf = c?.confidence;
    if (!(Number.isInteger(cf) && cf >= 0 && cf <= 100)) errs.push(`${p}.confidence invalid`);
    if (c?.reason !== undefined && c?.reason !== null) {
      if (typeof c.reason !== "string" || c.reason.length > 200) errs.push(`${p}.reason invalid`);
    }
    const pc = c?.proposedCategory;
    if (pc !== undefined && pc !== null) {
      if (typeof pc !== "object") errs.push(`${p}.proposedCategory invalid`);
      else {
        if (typeof pc.name !== "string" || pc.name.length < 1 || pc.name.length > 80)
          errs.push(`${p}.proposedCategory.name invalid`);
        const ps = pc.parentSlug;
        if (!(ps === null || (typeof ps === "string" && ps.length >= 1 && ps.length <= 60)))
          errs.push(`${p}.proposedCategory.parentSlug invalid`);
      }
    }
  });
  return errs;
}

/**
 * The production Zod schema itself, rebuilt verbatim from the sliced source
 * with `z` injected. This is the exact object production hands to
 * zodOutputFormat(), so the Anthropic path here IS the production path.
 */
export function makeResponseSchema(z) {
  const body = SCHEMA_SRC.slice(SCHEMA_SRC.indexOf("z.object({"));
  const expr = body.replace(/\);\s*$/, ")").trim();
  return new Function("z", `return ${expr};`)(z);
}
