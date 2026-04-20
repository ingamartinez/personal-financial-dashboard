import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "ai/anthropic-client" });

// Haiku 4.5 is the cost-effective default for Findash's two primary AI
// workloads today: transaction classification and SMS parse fallback. Per
// AI Strategy (see engram memory): Haiku for hot-path-ish and bulk work,
// Sonnet reserved for conversational / multi-step reasoning.
// Callsites needing a different model must pass `model` explicitly.
export const DEFAULT_MODEL = "claude-haiku-4-5";

// Parse/classify responses are tiny structured JSON blobs — not long prose.
// Keep the default small to bound latency; callers override when they need
// room (batch classification with many items).
export const DEFAULT_MAX_TOKENS = 1024;

export type SystemPromptBlock = {
  text: string;
  // When true, adds cache_control: { type: "ephemeral" } to this block. Use
  // for stable content (category list, few-shots, task instructions). Cache
  // only takes effect once the prefix exceeds the model minimum (Haiku 4.5:
  // 4096 tokens, Sonnet 4.6: 2048 tokens); shorter prefixes silently won't
  // cache but the marker is harmless. See shared/prompt-caching.md.
  cacheControl?: boolean;
};

export type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

type BaseCallOpts = {
  system?: string | SystemPromptBlock[];
  userPrompt: string;
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

/**
 * Structured call — use for any response that should be validated against a
 * Zod schema. Uses messages.parse() + output_config.format so the server
 * rejects hallucinated shapes before we touch the payload.
 */
export async function callClaude<T>(opts: CallClaudeOpts<T>): Promise<CallClaudeResult<T>> {
  const client = buildClient(opts);
  const model = opts.model ?? DEFAULT_MODEL;

  return runWithErrorHandling(model, async () => {
    const response = await client.messages.parse({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...systemField(opts.system),
      messages: [{ role: "user", content: opts.userPrompt }],
      output_config: { format: zodOutputFormat(opts.schema) },
    });

    if (response.parsed_output == null) {
      throw new Error(
        `Claude response did not parse against schema (stop_reason=${response.stop_reason})`,
      );
    }

    return {
      data: response.parsed_output,
      model: response.model,
      usage: extractUsage(response.usage),
    };
  });
}

/**
 * Prose call — use when the response is free-form text (markdown, long
 * analysis). No schema means no server-side format constraint; the caller
 * is responsible for any downstream validation.
 */
export async function callClaudeText(opts: BaseCallOpts): Promise<CallClaudeTextResult> {
  const client = buildClient(opts);
  const model = opts.model ?? DEFAULT_MODEL;

  return runWithErrorHandling(model, async () => {
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...systemField(opts.system),
      messages: [{ role: "user", content: opts.userPrompt }],
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

    return {
      text,
      model: response.model,
      usage: extractUsage(response.usage),
    };
  });
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

function extractUsage(usage: Anthropic.Usage): ClaudeUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
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
