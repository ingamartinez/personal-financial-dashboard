import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "ai/anthropic-client" });

// Sonnet 5 is the shared default after the #816 provider eval: better
// classification quality than Haiku at still-reasonable cost, and cheaper
// than the previous insights model (Sonnet 4.6). Call sites that must stay
// on Haiku (OCR extraction) pass `model` explicitly.
export const DEFAULT_MODEL = "claude-sonnet-5";
export const HAIKU_MODEL = "claude-haiku-4-5";

// Parse/classify responses are tiny structured JSON blobs — not long prose.
// Keep the default small to bound latency; callers override when they need
// room (batch classification with many items).
export const DEFAULT_MAX_TOKENS = 1024;

// Prompt-caching minima from Anthropic docs (Claude API). Below the minimum
// the cache_control marker is accepted and silently ignored — no error.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const CACHE_MIN_TOKENS_HAIKU = 4096;
const CACHE_MIN_TOKENS_SONNET = 1024;
const CACHE_MIN_TOKENS_UNKNOWN = 4096;

export type ClaudeFeature =
  | "classification"
  | "insights"
  | "nlu"
  | "ocr"
  | "sms-fallback"
  | "canary"
  | "pdf-vision";

export type ClaudeImage = {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
};

export type SystemPromptBlock = {
  text: string;
  // When true, adds cache_control: { type: "ephemeral" } to this block. Use
  // for stable content (category list, few-shots, task instructions). Cache
  // only takes effect once the prefix exceeds the model minimum (Haiku 4.5:
  // 4096 tokens, Sonnet 5: 1024 tokens); shorter prefixes silently won't
  // cache. We warn when the estimated prefix is below the active minimum.
  cacheControl?: boolean;
};

export type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

type BaseCallOpts = {
  // Who made the call — required so usage logs can answer "how much does
  // classification cost?" even when two features share a model.
  feature: ClaudeFeature;
  system?: string | SystemPromptBlock[];
  userPrompt: string;
  // Optional vision parts prepended to the user message. Used by OCR.
  images?: ClaudeImage[];
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  // Per-request timeout. Pipelines with hard budgets (SMS AI fallback: 2s)
  // must set this explicitly.
  timeoutMs?: number;
  // Test seam — the SDK passes this through as its HTTP transport.
  fetchImpl?: typeof fetch;
};

export type CallClaudeOpts<T> = BaseCallOpts & {
  // Zod schema for the model's JSON response. Enforced server-side via
  // output_config.format — rejects hallucinations before they reach us.
  schema: ZodType<T>;
};

export type CallClaudeResult<T> = {
  data: T;
  model: string;
  usage: ClaudeUsage;
};

export type CallClaudeTextResult = {
  text: string;
  model: string;
  usage: ClaudeUsage;
};

export type CachePrefixInspection = {
  cacheRequested: boolean;
  estimatedTokens: number;
  minTokens: number;
  belowMin: boolean;
};

/**
 * Documented minimum cacheable prefix for the active model. Unknown /
 * unrecognized IDs fail closed at the Haiku threshold so we warn rather
 * than assume caching works.
 */
export function cacheMinimumTokens(model: string): number {
  const id = model.toLowerCase();
  if (id.includes("haiku")) return CACHE_MIN_TOKENS_HAIKU;
  if (id.includes("sonnet")) return CACHE_MIN_TOKENS_SONNET;
  return CACHE_MIN_TOKENS_UNKNOWN;
}

/**
 * Estimate the cacheable prefix (system blocks up to and including the last
 * cache_control breakpoint) with a chars/4 heuristic. Used only to decide
 * whether to warn — not a substitute for countTokens, and we do not pad.
 */
export function inspectCacheablePrefix(
  model: string,
  system: BaseCallOpts["system"],
): CachePrefixInspection {
  const minTokens = cacheMinimumTokens(model);
  if (!system || typeof system === "string") {
    return { cacheRequested: false, estimatedTokens: 0, minTokens, belowMin: false };
  }
  let lastBreakpoint = -1;
  for (let i = 0; i < system.length; i++) {
    if (system[i].cacheControl) lastBreakpoint = i;
  }
  if (lastBreakpoint < 0) {
    return { cacheRequested: false, estimatedTokens: 0, minTokens, belowMin: false };
  }
  const prefixChars = system
    .slice(0, lastBreakpoint + 1)
    .reduce((n, block) => n + block.text.length, 0);
  const estimatedTokens = Math.ceil(prefixChars / 4);
  return {
    cacheRequested: true,
    estimatedTokens,
    minTokens,
    belowMin: estimatedTokens < minTokens,
  };
}

/**
 * Structured call — use for any response that should be validated against a
 * Zod schema. Uses messages.parse() + output_config.format so the server
 * rejects hallucinated shapes before we touch the payload.
 */
export async function callClaude<T>(opts: CallClaudeOpts<T>): Promise<CallClaudeResult<T>> {
  assertNoTools(opts, "callClaude");
  const client = buildClient(opts);
  const model = opts.model ?? DEFAULT_MODEL;
  warnIfCachePrefixBelowMin(model, opts.system);
  const started = performance.now();

  return runWithErrorHandling(model, async () => {
    const response = await client.messages.parse({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...systemField(opts.system),
      messages: [buildUserMessage(opts.userPrompt, opts.images)],
      output_config: { format: zodOutputFormat(opts.schema) },
    });

    if (response.parsed_output == null) {
      throw new Error(
        `Claude response did not parse against schema (stop_reason=${response.stop_reason})`,
      );
    }

    const usage = extractUsage(response.usage);
    logUsage({
      feature: opts.feature,
      model,
      usage,
      durationMs: Math.round(performance.now() - started),
    });

    return {
      data: response.parsed_output,
      model: response.model,
      usage,
    };
  });
}

/**
 * Prose call — use when the response is free-form text (markdown, long
 * analysis). No schema means no server-side format constraint; the caller
 * is responsible for any downstream validation.
 */
export async function callClaudeText(opts: BaseCallOpts): Promise<CallClaudeTextResult> {
  assertNoTools(opts, "callClaudeText");
  const client = buildClient(opts);
  const model = opts.model ?? DEFAULT_MODEL;
  warnIfCachePrefixBelowMin(model, opts.system);
  const started = performance.now();

  return runWithErrorHandling(model, async () => {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...systemField(opts.system),
      messages: [buildUserMessage(opts.userPrompt, opts.images)],
    });

    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    if (!text) {
      throw new Error(
        `Claude returned empty text (stop_reason=${response.stop_reason}, blocks=${response.content.length})`,
      );
    }

    const usage = extractUsage(response.usage);
    logUsage({
      feature: opts.feature,
      model,
      usage,
      durationMs: Math.round(performance.now() - started),
    });

    return {
      text,
      model: response.model,
      usage,
    };
  });
}

function assertNoTools(opts: object, fnName: "callClaude" | "callClaudeText"): void {
  if (Object.hasOwn(opts, "tools")) {
    throw new Error(`${fnName} refuses tools — web search belongs on the merchant-lookup client`);
  }
}

function buildClient(opts: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Anthropic {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const clientOpts: { apiKey: string; fetch?: typeof fetch; timeout?: number } = { apiKey };
  if (opts.fetchImpl) clientOpts.fetch = opts.fetchImpl;
  if (opts.timeoutMs !== undefined) clientOpts.timeout = opts.timeoutMs;
  return new Anthropic(clientOpts);
}

function systemField(
  system: BaseCallOpts["system"],
): { system: Anthropic.TextBlockParam[] } | Record<string, never> {
  const blocks = buildSystemBlocks(system);
  return blocks ? { system: blocks } : {};
}

function buildSystemBlocks(system: BaseCallOpts["system"]): Anthropic.TextBlockParam[] | undefined {
  if (!system) return undefined;
  if (typeof system === "string") {
    return [{ type: "text", text: system }];
  }
  return system.map<Anthropic.TextBlockParam>((block) =>
    block.cacheControl
      ? { type: "text", text: block.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: block.text },
  );
}

function buildUserMessage(userPrompt: string, images?: ClaudeImage[]): Anthropic.MessageParam {
  if (!images || images.length === 0) {
    return { role: "user", content: userPrompt };
  }
  return {
    role: "user",
    content: [
      ...images.map((img) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mediaType,
          data: img.data,
        },
      })),
      { type: "text" as const, text: userPrompt },
    ],
  };
}

function extractUsage(usage: Anthropic.Usage): ClaudeUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function warnIfCachePrefixBelowMin(model: string, system: BaseCallOpts["system"]): void {
  const inspection = inspectCacheablePrefix(model, system);
  if (!inspection.belowMin) return;
  log.warn(
    {
      event: "ai_cache_prefix_below_min",
      model,
      estimatedPrefixTokens: inspection.estimatedTokens,
      minCacheTokens: inspection.minTokens,
    },
    "cache_control prefix below model minimum; cache will be a silent no-op",
  );
}

function logUsage(opts: {
  feature: ClaudeFeature;
  model: string;
  usage: ClaudeUsage;
  durationMs: number;
}): void {
  log.info(
    {
      event: "ai_usage",
      feature: opts.feature,
      model: opts.model,
      inputTokens: opts.usage.inputTokens,
      outputTokens: opts.usage.outputTokens,
      cacheReadTokens: opts.usage.cacheReadTokens,
      cacheCreationTokens: opts.usage.cacheCreationTokens,
      durationMs: opts.durationMs,
      cacheHit: opts.usage.cacheReadTokens > 0,
    },
    "anthropic usage",
  );
}

async function runWithErrorHandling<T>(model: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      log.warn({ err, model, event: "ai_rate_limited" }, "anthropic rate limited");
    } else if (err instanceof Anthropic.APIError) {
      log.error({ err, model, status: err.status, event: "ai_api_error" }, "anthropic api error");
    }
    throw err;
  }
}
