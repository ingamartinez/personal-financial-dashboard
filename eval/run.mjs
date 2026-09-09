// Runs the findash transaction-classification eval against every model in the
// roster. Every provider receives byte-identical system + user prompts, built
// verbatim from src/lib/classification/ai.ts.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildSystemPrompt,
  buildUserPrompt,
  validateResponse,
  makeResponseSchema,
} from "./prompt.mjs";
import { MODELS, ENDPOINTS } from "./models.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "results");
fs.mkdirSync(OUT, { recursive: true });

const AI_BATCH_SIZE = 20; // src/lib/classification/pipeline.ts
// Production sets 2048 (classifyBatchWithAi). Several candidates are reasoning
// models whose thinking tokens count against this ceiling, so a uniform 2048
// would truncate them — a harness artifact, not a quality signal. The ceiling is
// raised uniformly for every provider; cost is computed from tokens ACTUALLY
// emitted, so a model that thinks more simply pays more. Batches whose output
// exceeded 2048 are flagged, because that is a real constraint on dropping the
// model into the current pipeline unchanged.
const MAX_TOKENS = 8192;
const PROD_MAX_TOKENS = 2048;

const ds = JSON.parse(fs.readFileSync(path.join(DIR, "dataset.json"), "utf8"));

// #812 layer 1 — system-owned slugs are never offered to the model.
const SYSTEM_OWNED = new Set(["adjustments"]);
const promptCategories = ds.categories.filter((c) => !SYSTEM_OWNED.has(c.slug));
const SYSTEM = buildSystemPrompt(promptCategories);

function batches(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += AI_BATCH_SIZE) out.push(rows.slice(i, i + AI_BATCH_SIZE));
  return out;
}
const ALL_BATCHES = [
  ...batches(ds.setA).map((b, i) => ({ set: "A", idx: i, rows: b })),
  ...batches(ds.setB).map((b, i) => ({ set: "B", idx: i, rows: b })),
];

const userPromptFor = (rows) =>
  buildUserPrompt(
    rows.map((r) => ({
      id: r.id,
      description: r.description,
      amountCents: BigInt(r.amountCents),
      currency: r.currency,
    })),
    [],
  );

// --------------------------------------------------------------------------
// Adapters. Prompts are identical; only the structured-output mechanism and
// the auth envelope differ (each provider's own native JSON-schema mode).
// --------------------------------------------------------------------------
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// The production Zod schema, rebuilt verbatim from ai.ts, and the single JSON
// Schema derived from it. Anthropic gets it through zodOutputFormat exactly as
// classifyBatchWithAi does; the OpenAI-compatible providers get the very same
// converted schema object, so no provider is handed a richer or poorer contract.
const responseSchema = makeResponseSchema(z);
const outputFormat = zodOutputFormat(responseSchema, "classifications");
const jsonSchema = outputFormat.schema;

async function callAnthropic(spec, userPrompt) {
  const res = await anthropic.messages.create({
    model: spec.model,
    max_tokens: MAX_TOKENS,
    // cache_control mirrors production (classifyBatchWithAi). The prefix is
    // well under the 4096-token Haiku minimum, so it is expected to be a no-op
    // here; measured cache tokens are recorded either way.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: outputFormat },
  });
  const text = res.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  return {
    text,
    usage: {
      in: res.usage.input_tokens,
      out: res.usage.output_tokens,
      cachedIn: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
    },
    stop: res.stop_reason,
  };
}

async function callOpenAICompat(spec, userPrompt) {
  const ep = ENDPOINTS[spec.provider];
  const body = {
    model: spec.model,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt },
    ],
  };
  // DeepSeek (2026-09-09) rejects response_format json_schema outright
  // ("This response_format type is unavailable now") and rejects json_object
  // unless the prompt literally contains the word "json" — which the
  // production prompt does not. Adding it would be per-provider prompt tuning,
  // so DeepSeek runs unconstrained. That is itself the finding.
  if (spec.provider !== "deepseek") {
    body.response_format = {
      type: "json_schema",
      // strict:false — the production schema leaves `reason` and
      // `proposedCategory` optional, and OpenAI-style strict mode demands every
      // property appear in `required`. Forcing them in would change what the
      // model is asked to emit, so the looser mode preserves the real contract.
      json_schema: { name: "classifications", strict: false, schema: jsonSchema },
    };
  }
  const res = await fetch(ep.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env[ep.keyEnv]}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.detail = errText.slice(0, 600);
    throw err;
  }
  const j = await res.json();
  const choice = j.choices?.[0];
  const u = j.usage ?? {};
  const cachedIn = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  // xAI reports reasoning tokens OUTSIDE completion_tokens — verified against
  // its own cost_in_usd_ticks (1286*$1.25 + 192*$0.20 + (132+397)*$2.50 per
  // MTok == 29684000 ticks == $0.0029684). Groq and DeepSeek include them.
  const out = (u.completion_tokens ?? 0) + (spec.provider === "xai" ? reasoning : 0);
  return {
    text: (choice?.message?.content ?? "").trim(),
    usage: {
      in: (u.prompt_tokens ?? 0) - cachedIn,
      out,
      cachedIn,
      cacheWrite: 0,
      reasoning,
      providerCostUsd:
        j.usage?.cost_in_usd_ticks != null ? j.usage.cost_in_usd_ticks / 1e10 : undefined,
    },
    stop: choice?.finish_reason,
  };
}

const call = (spec, up) =>
  spec.provider === "anthropic" ? callAnthropic(spec, up) : callOpenAICompat(spec, up);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tag) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.status ?? e?.error?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || status === undefined;
      process.stderr.write(
        `    ! ${tag} attempt ${attempt + 1} failed: ${status ?? "?"} ${String(e.message).slice(0, 120)}\n`,
      );
      if (!retryable || attempt === 2) break;
      // Honour the provider's own retry hint when it gives one (Groq's free
      // tier is 8k TPM and asks for ~13s); otherwise exponential backoff.
      const hinted = /try again in ([\d.]+)s/.exec(e.detail ?? "");
      await sleep(hinted ? Math.ceil(parseFloat(hinted[1]) * 1000) + 1500 : 2000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// --------------------------------------------------------------------------

const PACE_MS = Number(process.env.PACE_MS ?? 400);
const only = process.argv.slice(2);
const roster = only.length ? MODELS.filter((m) => only.some((o) => m.key.includes(o))) : MODELS;

for (const spec of roster) {
  const outFile = path.join(OUT, `${spec.key.replace(/\//g, "__")}.json`);
  if (fs.existsSync(outFile)) {
    console.log(`= ${spec.key} — already done, skipping`);
    continue;
  }
  console.log(`\n>> ${spec.key} (${spec.label})`);
  const record = { key: spec.key, label: spec.label, model: spec.model, batches: [] };
  let hardFail = null;

  for (const b of ALL_BATCHES) {
    const up = userPromptFor(b.rows);
    const tag = `${spec.key} ${b.set}${b.idx}`;
    const t0 = performance.now();
    try {
      const r = await withRetry(() => call(spec, up), tag);
      const latencyMs = performance.now() - t0;
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(r.text);
      } catch (e) {
        // Some providers wrap JSON in a ```json fence. Try once more.
        const fence = r.text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) {
          try {
            parsed = JSON.parse(fence[1]);
          } catch {
            /* fall through */
          }
        }
        if (!parsed) parseError = String(e.message).slice(0, 200);
      }

      // STRICT = what production's Zod schema would accept, unchanged.
      const schemaErrors = parsed ? validateResponse(parsed) : ["unparseable JSON"];

      // SHIMMED = what it would take to make this provider usable: unwrap a
      // bare top-level array into { classifications: [...] }. Recorded so the
      // report can quantify the cost of adopting the provider rather than
      // just failing it.
      const shimmed = Array.isArray(parsed) ? { classifications: parsed } : parsed;
      const shimApplied = Array.isArray(parsed);
      const schemaErrorsShimmed = shimmed ? validateResponse(shimmed) : ["unparseable JSON"];

      record.batches.push({
        set: b.set,
        idx: b.idx,
        ids: b.rows.map((x) => x.id),
        latencyMs,
        usage: r.usage,
        stop: r.stop,
        parseError,
        schemaErrors,
        schemaErrorsShimmed,
        shimApplied,
        rawLen: r.text.length,
        exceedsProdMaxTokens: r.usage.out > PROD_MAX_TOKENS,
        raw: schemaErrorsShimmed.length ? r.text.slice(0, 2000) : undefined,
        classifications: shimmed?.classifications ?? null,
      });
      const bad = schemaErrors.length
        ? ` STRICT-FAIL(${schemaErrors.length})${schemaErrorsShimmed.length ? "" : " [shim-ok]"}`
        : "";
      console.log(
        `   ${b.set}${b.idx} ${Math.round(latencyMs)}ms in=${r.usage.in} cached=${r.usage.cachedIn} out=${r.usage.out}${bad}`,
      );
    } catch (e) {
      console.log(
        `   ${b.set}${b.idx} FAILED: ${e.status ?? "?"} ${String(e.message).slice(0, 160)}`,
      );
      record.batches.push({
        set: b.set,
        idx: b.idx,
        ids: b.rows.map((x) => x.id),
        failed: true,
        status: e.status ?? null,
        detail: e.detail ?? String(e.message).slice(0, 600),
      });
      if (record.batches.filter((x) => x.failed).length >= 3) {
        hardFail = `3+ batch failures — aborting ${spec.key}`;
        break;
      }
    }
    await sleep(PACE_MS);
  }
  record.hardFail = hardFail;
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  if (hardFail) console.log(`   !! ${hardFail}`);
}
console.log("\ndone");
